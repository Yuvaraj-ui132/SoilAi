"""Deterministic, fully local scikit-learn soil compaction prediction pipeline."""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import TypedDict

import joblib
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split

LOGGER = logging.getLogger(__name__)
MODEL_PATH = Path(__file__).resolve().parent / "models" / "soil_rf.joblib"
FEATURE_NAMES = ("liquid_limit", "plastic_limit", "plasticity_index")


class RegressionMetrics(TypedDict):
    r2: float
    mae: float


class SoilModelBundle(TypedDict):
    bundle_version: int
    model: RandomForestRegressor
    metrics: dict[str, RegressionMetrics]
    feature_names: tuple[str, ...]


def generate_synthetic_dataset(
    sample_count: int = 1000, random_state: int = 42
) -> tuple[np.ndarray, np.ndarray]:
    """Create deterministic literature-shaped LL/PL and OMC/MDD training data."""
    if sample_count < 5:
        raise ValueError("sample_count must be at least 5")

    rng = np.random.default_rng(random_state)
    liquid_limits: list[float] = []
    plastic_limits: list[float] = []
    while len(liquid_limits) < sample_count:
        remaining = sample_count - len(liquid_limits)
        proposed_count = max(remaining * 2, 16)
        proposed_ll = rng.uniform(15.0, 80.0, proposed_count)
        proposed_pl = rng.uniform(10.0, 40.0, proposed_count)
        valid = proposed_ll > proposed_pl
        liquid_limits.extend(proposed_ll[valid][:remaining].tolist())
        plastic_limits.extend(proposed_pl[valid][:remaining].tolist())

    ll = np.asarray(liquid_limits, dtype=np.float64)
    pl = np.asarray(plastic_limits, dtype=np.float64)
    pi = ll - pl
    omc_noise = rng.normal(0.0, 0.6, sample_count)
    omc = np.clip(10.5 + 0.35 * pl + 0.12 * pi + omc_noise, 6.0, 35.0)
    mdd_noise = rng.normal(0.0, 0.03, sample_count)
    mdd = np.clip(2.25 - 0.012 * omc - 0.003 * pi + mdd_noise, 1.35, 2.20)

    features = np.column_stack((ll, pl, pi))
    targets = np.column_stack((omc, mdd))
    return features, targets


def _train_bundle() -> SoilModelBundle:
    features, targets = generate_synthetic_dataset(sample_count=1000, random_state=42)
    x_train, x_test, y_train, y_test = train_test_split(
        features, targets, test_size=0.2, random_state=42
    )
    model = RandomForestRegressor(
        n_estimators=100,
        max_depth=8,
        random_state=42,
        n_jobs=-1,
        max_samples=0.25,
    )
    model.fit(x_train, y_train)
    predictions = model.predict(x_test)
    metrics: dict[str, RegressionMetrics] = {}

    for index, target_name in enumerate(("omc", "mdd")):
        metrics[target_name] = {
            "r2": float(r2_score(y_test[:, index], predictions[:, index])),
            "mae": float(mean_absolute_error(y_test[:, index], predictions[:, index])),
        }

    return {
        "bundle_version": 1,
        "model": model,
        "metrics": metrics,
        "feature_names": FEATURE_NAMES,
    }


def train_or_load_model(
    model_path: str | Path = MODEL_PATH, force_train: bool = False
) -> SoilModelBundle:
    """Load the persisted bundle or train, measure, and atomically persist one."""
    path = Path(model_path)
    if path.exists() and not force_train:
        bundle = joblib.load(path)
        if not (
            not isinstance(bundle, dict)
            or bundle.get("bundle_version") != 1
            or bundle.get("feature_names") != FEATURE_NAMES
            or not isinstance(bundle.get("model"), RandomForestRegressor)
            or not {"omc", "mdd"}.issubset(bundle.get("metrics", {}))
        ):
            return bundle
        LOGGER.warning("SoilAI model cache is stale or invalid; retraining it: %s", path)

    bundle = _train_bundle()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
        joblib.dump(bundle, temporary_path)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()

    for target_name, metrics in bundle["metrics"].items():
        LOGGER.info(
            "Local soil model %s holdout metrics: R2=%.4f MAE=%.4f",
            target_name.upper(),
            metrics["r2"],
            metrics["mae"],
        )
    return bundle


def generate_geotechnical_verdict(
    ll: float,
    pl: float,
    pi: float,
    predicted_omc: float,
    predicted_mdd: float,
) -> dict[str, str]:
    """Classify the soil and provide deterministic field-compaction guidance."""
    values = (ll, pl, pi, predicted_omc, predicted_mdd)
    if not all(np.isfinite(value) for value in values):
        raise ValueError("Verdict inputs must be finite numbers")
    if not ll > pl >= 0 or not np.isclose(pi, ll - pl):
        raise ValueError("Liquid limit, plastic limit, and PI are inconsistent")

    a_line = 0.73 * (ll - 20.0)
    if ll < 50.0:
        if pi > a_line and pi > 7.0:
            uscs = "CL (Lean Clay)"
        elif pi < a_line and pi < 4.0:
            uscs = "ML (Low-Plasticity Silt)"
        else:
            uscs = "CL-ML (Silty Clay)"
    elif pi >= a_line:
        uscs = "CH (Fat Clay / High Plasticity)"
    else:
        uscs = "MH (Elastic Silt)"

    if predicted_mdd >= 1.85:
        suitability = "Excellent Subgrade (High bearing capacity, low compressibility)"
    elif predicted_mdd >= 1.65:
        suitability = "Fair to Good Subgrade (Suitable for highway subgrade with standard compaction)"
    else:
        suitability = "Poor / Suboptimal Subgrade (Prone to settlement/heave; lime or cement stabilization recommended)"

    if pi > 20.0:
        moisture_sensitivity = (
            "High sensitivity to field moisture; strict moisture control required (OMC ± 1.5%)"
        )
    else:
        moisture_sensitivity = "Tolerant moisture window (OMC -2.0% to +1.0%)"

    cohesive = uscs.startswith(("CL ", "CH ", "CL-ML "))
    roller = (
        "Tamping foot / Sheepsfoot roller"
        if cohesive
        else "Smooth-wheel or Pneumatic-tired roller"
    )
    return {
        "uscs_classification": uscs,
        "suitability": suitability,
        "moisture_sensitivity": moisture_sensitivity,
        "roller_recommendation": roller,
    }


def predict_compaction_parameters(
    ll: float, pl: float, model_bundle: SoilModelBundle | None = None
) -> dict:
    """Predict bounded compaction parameters and return verdict/confidence data."""
    if not np.isfinite(ll) or not np.isfinite(pl) or ll <= pl:
        raise ValueError("Inputs must be finite and liquid limit must exceed plastic limit")
    pi = ll - pl
    bundle = model_bundle or MODEL_BUNDLE
    features = np.asarray([[ll, pl, pi]], dtype=np.float64)
    predictions = bundle["model"].predict(features)[0]
    predicted_omc = float(np.clip(predictions[0], 6.0, 35.0))
    predicted_mdd = float(np.clip(predictions[1], 1.35, 2.20))
    verdict = generate_geotechnical_verdict(ll, pl, pi, predicted_omc, predicted_mdd)
    return {
        "predicted_omc": round(predicted_omc, 2),
        "predicted_mdd": round(predicted_mdd, 3),
        "plasticity_index": round(float(pi), 2),
        "uscs_classification": verdict["uscs_classification"],
        "verdict": {
            "suitability": verdict["suitability"],
            "moisture_sensitivity": verdict["moisture_sensitivity"],
            "roller_recommendation": verdict["roller_recommendation"],
        },
        "model_confidence": {
            "omc_r2": bundle["metrics"]["omc"]["r2"],
            "omc_mae": bundle["metrics"]["omc"]["mae"],
            "mdd_r2": bundle["metrics"]["mdd"]["r2"],
            "mdd_mae": bundle["metrics"]["mdd"]["mae"],
        },
    }


MODEL_BUNDLE = train_or_load_model()
