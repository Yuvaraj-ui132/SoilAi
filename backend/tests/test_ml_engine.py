import sys
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import app
from ml_engine import (
    MODEL_BUNDLE,
    generate_synthetic_dataset,
    generate_geotechnical_verdict,
    predict_compaction_parameters,
    train_or_load_model,
)


def test_synthetic_training_dataset_is_reproducible_and_valid():
    features_a, targets_a = generate_synthetic_dataset()
    features_b, targets_b = generate_synthetic_dataset()

    assert features_a.shape == (1000, 3)
    assert targets_a.shape == (1000, 2)
    assert np.array_equal(features_a, features_b)
    assert np.array_equal(targets_a, targets_b)
    assert np.all(features_a[:, 0] > features_a[:, 1])
    assert np.all(np.isfinite(features_a))
    assert np.all(np.isfinite(targets_a))


def test_model_training_and_loading_initialize_bundle(tmp_path):
    model_path = tmp_path / "soil_rf.joblib"
    trained = train_or_load_model(model_path, force_train=True)
    loaded = train_or_load_model(model_path)

    assert model_path.is_file()
    assert trained["feature_names"] == ("liquid_limit", "plastic_limit", "plasticity_index")
    assert loaded["feature_names"] == trained["feature_names"]
    assert set(loaded["metrics"]) == {"omc", "mdd"}
    assert loaded["sklearn_version"]
    assert all(0 <= loaded["metrics"][target]["r2"] <= 1 for target in ("omc", "mdd"))
    assert all(loaded["metrics"][target]["mae"] >= 0 for target in ("omc", "mdd"))


def test_corrupt_model_cache_is_retrained(tmp_path):
    model_path = tmp_path / "corrupt-soil-model.joblib"
    model_path.write_bytes(b"not a joblib model")
    bundle = train_or_load_model(model_path)

    assert bundle["feature_names"] == ("liquid_limit", "plastic_limit", "plasticity_index")
    assert model_path.is_file()
    assert predict_compaction_parameters(60, 25, bundle)["predicted_omc"] <= 35.0


@pytest.mark.parametrize(("ll", "pl"), [(15, 10), (100, 10), (80, 60), (62, 26)])
def test_prediction_stays_within_physical_bounds(ll, pl):
    result = predict_compaction_parameters(ll, pl, MODEL_BUNDLE)
    assert 6.0 <= result["predicted_omc"] <= 35.0
    assert 1.35 <= result["predicted_mdd"] <= 2.20
    assert result["plasticity_index"] == pytest.approx(ll - pl)


@pytest.mark.parametrize(
    ("ll", "pl"),
    [
        (40, 40),
        (20, 25),
        (float("nan"), 10),
        (float("inf"), 10),
        (50, -float("inf")),
    ],
)
def test_prediction_rejects_invalid_or_non_finite_limits(ll, pl):
    with pytest.raises((ValueError, ValidationError)):
        predict_compaction_parameters(ll, pl, MODEL_BUNDLE)


def test_known_casagrande_benchmark_classifies_high_plasticity_clay():
    verdict = generate_geotechnical_verdict(
        ll=60, pl=25, pi=35, predicted_omc=20, predicted_mdd=1.9
    )
    assert verdict["uscs_classification"] == "CH (Fat Clay / High Plasticity)"
    assert verdict["roller_recommendation"] == "Tamping foot / Sheepsfoot roller"
    assert "OMC ± 1.5%" in verdict["moisture_sensitivity"]


def test_uscs_low_plasticity_and_silty_cases():
    low_plasticity = generate_geotechnical_verdict(30, 27, 3, 12, 1.7)
    high_ll_silt = generate_geotechnical_verdict(60, 50, 10, 18, 1.7)
    assert low_plasticity["uscs_classification"] == "ML (Low-Plasticity Silt)"
    assert high_ll_silt["uscs_classification"] == "MH (Elastic Silt)"
    assert high_ll_silt["roller_recommendation"] == "Smooth-wheel or Pneumatic-tired roller"


@pytest.fixture()
def client():
    app.config.update(TESTING=True)
    with app.test_client() as test_client:
        yield test_client


def test_predict_endpoint_returns_typed_result(client):
    response = client.post("/api/predict", json={"liquid_limit": 60, "plastic_limit": 25})
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["success"] is True
    assert payload["uscs_classification"] == "CH (Fat Clay / High Plasticity)"
    assert payload["verdict"]["suitability"]
    assert set(payload["model_confidence"]) == {"omc_r2", "omc_mae", "mdd_r2", "mdd_mae"}
    assert "synthetic holdout" in payload["model_metrics_note"]
    assert payload["predicted_omc"] == round(payload["predicted_omc"], 2)
    assert payload["predicted_mdd"] == round(payload["predicted_mdd"], 3)


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"liquid_limit": 60, "plastic_limit": None},
        {"liquid_limit": 14.9, "plastic_limit": 10},
        {"liquid_limit": 60, "plastic_limit": 60},
        {"liquid_limit": float("nan"), "plastic_limit": 10},
        {"liquid_limit": 60, "plastic_limit": float("inf")},
    ],
)
def test_predict_endpoint_returns_422_for_invalid_limits(client, payload):
    response = client.post("/api/predict", json=payload)
    assert response.status_code == 422
    assert response.get_json()["details"]
