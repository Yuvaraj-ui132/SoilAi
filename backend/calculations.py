"""Validated geotechnical calculations and local engineering estimators."""

import math
from typing import Optional

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from pydantic_core import PydanticCustomError
from scipy.stats import pearsonr


class TrialInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    container_no: str = Field(min_length=1, max_length=40)
    W1: float = Field(gt=0, description="Empty container tare mass in grams")
    W2: float = Field(description="Wet soil and tare mass in grams")
    W3: float = Field(description="Dry soil and tare mass in grams")
    wet_density: float = Field(ge=0.8, le=3.0, description="Wet density in g/cm³")

    @model_validator(mode="after")
    def validate_masses(self):
        errors = []
        for field_name in ("W1", "W2", "W3", "wet_density"):
            if not math.isfinite(getattr(self, field_name)):
                errors.append({
                    "type": PydanticCustomError("finite_number", "{field} must be a finite number", {"field": field_name}),
                    "loc": (field_name,),
                    "input": getattr(self, field_name),
                })
        if not errors:
            if self.W2 <= self.W3:
                errors.append({
                    "type": PydanticCustomError("mass_order", "W2 must be greater than W3"),
                    "loc": ("W2",),
                    "input": self.W2,
                })
            if self.W3 <= self.W1:
                errors.append({
                    "type": PydanticCustomError("mass_order", "W3 must be greater than W1"),
                    "loc": ("W3",),
                    "input": self.W3,
                })
        if errors:
            raise ValidationError.from_exception_data("TrialInput", errors)
        return self


class SoilTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    test_name: str = Field(min_length=1, max_length=120)
    soil_type: str = Field(min_length=1, max_length=80)
    trials: list[TrialInput] = Field(min_length=4, max_length=10)
    specific_gravity: Optional[float] = Field(default=2.65, ge=2.4, le=3.0)
    liquid_limit: Optional[float] = Field(default=None, gt=0, le=200)
    plastic_limit: Optional[float] = Field(default=None, ge=0, le=200)

    @model_validator(mode="after")
    def validate_optional_numbers(self):
        errors = []
        for field_name in ("specific_gravity", "liquid_limit", "plastic_limit"):
            value = getattr(self, field_name)
            if value is not None and not math.isfinite(value):
                errors.append({
                    "type": PydanticCustomError("finite_number", "{field} must be a finite number", {"field": field_name}),
                    "loc": (field_name,),
                    "input": value,
                })
        if self.liquid_limit is not None and self.plastic_limit is not None:
            if self.liquid_limit <= self.plastic_limit:
                errors.append({
                    "type": PydanticCustomError("limit_order", "liquid_limit must be greater than plastic_limit"),
                    "loc": ("liquid_limit",),
                    "input": self.liquid_limit,
                })
        if errors:
            raise ValidationError.from_exception_data("SoilTestRequest", errors)
        return self


def calculate_moisture_content(W1: float, W2: float, W3: float) -> float:
    """Calculate gravimetric moisture content as a percentage."""
    if not all(math.isfinite(value) for value in (W1, W2, W3)):
        raise ValueError("Masses must be finite numbers")
    if not W2 > W3 > W1:
        raise ValueError("Masses must satisfy W2 > W3 > W1")
    moisture = (W2 - W3) / (W3 - W1) * 100.0
    if not math.isfinite(moisture):
        raise ValueError("Calculated moisture content is outside the supported numeric range")
    return moisture


def calculate_dry_density(wet_density: float, moisture_content: float) -> float:
    """Calculate dry density in the same units as wet density."""
    if not math.isfinite(wet_density) or not 0.8 <= wet_density <= 3.0:
        raise ValueError("Wet density must be finite and between 0.8 and 3.0 g/cm³")
    if not math.isfinite(moisture_content) or moisture_content < 0:
        raise ValueError("Moisture content must be finite and non-negative")
    density = wet_density / (1.0 + moisture_content / 100.0)
    if not math.isfinite(density):
        raise ValueError("Calculated dry density is outside the supported numeric range")
    return density


def calculate_soil_test(test_request: SoilTestRequest) -> dict:
    """Calculate trial values, fitted compaction curve, ZAV curve, and evaluation."""
    trial_results = []
    for trial in test_request.trials:
        moisture = calculate_moisture_content(trial.W1, trial.W2, trial.W3)
        density = calculate_dry_density(trial.wet_density, moisture)
        trial_results.append({
            **trial.model_dump(),
            "moisture_content": moisture,
            "dry_density": density,
            "water_content_g": trial.W2 - trial.W3,
            "dry_soil_g": trial.W3 - trial.W1,
        })

    moisture_values = np.asarray([trial["moisture_content"] for trial in trial_results], dtype=float)
    density_values = np.asarray([trial["dry_density"] for trial in trial_results], dtype=float)
    try:
        coefficients = np.polyfit(moisture_values, density_values, 2)
    except (ValueError, np.linalg.LinAlgError, FloatingPointError):
        coefficients = np.asarray([0.0, 0.0, float(np.mean(density_values))])
    if not np.all(np.isfinite(coefficients)):
        coefficients = np.asarray([0.0, 0.0, float(np.mean(density_values))])
    a, b, c = (float(value) for value in coefficients)
    predicted = np.polyval(coefficients, moisture_values)
    residual_sum = float(np.sum((density_values - predicted) ** 2))
    total_sum = float(np.sum((density_values - np.mean(density_values)) ** 2))
    if total_sum == 0:
        r_squared = 1.0 if residual_sum == 0 else 0.0
    elif np.std(predicted) == 0 or np.std(density_values) == 0:
        r_squared = 1.0 - residual_sum / total_sum
    else:
        r_squared = float(pearsonr(density_values, predicted).statistic ** 2)
    if not math.isfinite(r_squared):
        r_squared = 0.0

    min_moisture = float(np.min(moisture_values))
    max_moisture = float(np.max(moisture_values))
    if a < 0:
        vertex = -b / (2.0 * a)
    else:
        vertex = math.nan
    if a < 0 and min_moisture <= vertex <= max_moisture:
        omc = vertex
        mdd = float(np.polyval(coefficients, vertex))
        peak_method = "quadratic_fit"
    else:
        peak_index = int(np.argmax(density_values))
        omc = float(moisture_values[peak_index])
        mdd = float(density_values[peak_index])
        peak_method = "measured_peak_fallback"

    specific_gravity = test_request.specific_gravity or 2.65
    zav_moistures = np.linspace(min_moisture - 2.0, max_moisture + 4.0, 60)
    zav_curve = [
        {
            "moisture": float(water_content),
            "dry_density": float(
                (specific_gravity * 1.0) /
                (1.0 + (water_content * specific_gravity / 100.0))
            ),
        }
        for water_content in zav_moistures
    ]

    evaluation = evaluate_compaction(omc, mdd, test_request.soil_type)
    return {
        "test_name": test_request.test_name,
        "soil_type": test_request.soil_type,
        "trials": trial_results,
        "omc": round(omc, 2),
        "mdd": round(mdd, 3),
        "fit": {"a": a, "b": b, "c": c, "r_squared": r_squared},
        "zav_curve": zav_curve,
        "evaluation": evaluation,
        "peak_method": peak_method,
        "average_moisture_content": float(np.mean(moisture_values)),
        "average_dry_density": float(np.mean(density_values)),
    }


def evaluate_compaction(omc: float, mdd: float, soil_type: str) -> dict:
    """Apply deterministic suitability, moisture-window, and equipment rules."""
    if not all(math.isfinite(value) for value in (omc, mdd)) or mdd <= 0:
        raise ValueError("OMC and MDD must be finite and MDD must be positive")
    if mdd > 1.8:
        suitability = "Excellent"
    elif mdd >= 1.5:
        suitability = "Fair"
    else:
        suitability = "Poor"

    soil_name = soil_type.lower()
    soil_codes = soil_name.replace("(", " ").replace(")", " ").split()
    cohesive = (
        "cohesive" in soil_name
        or (
            "clay" in soil_name
            and not any(code in {"gc", "gm", "gw", "gp", "sc", "sm", "sw", "sp"} for code in soil_codes)
        )
        or any(code in {"cl", "ch", "mh"} for code in soil_codes)
    )
    equipment = (
        "Sheepsfoot / Tamping roller"
        if cohesive
        else "Smooth-wheel / Vibratory roller"
    )
    return {
        "subgrade_suitability": suitability,
        "moisture_control_window": f"{omc - 2.0:.1f}% to {omc + 1.0:.1f}%",
        "recommended_equipment": equipment,
    }


def predict_compaction_parameters(
    liquid_limit: Optional[float], plastic_limit: Optional[float]
) -> dict:
    """Provide a transparent empirical, fully local PI-based estimate."""
    if liquid_limit is None or plastic_limit is None:
        raise ValueError("Both liquid_limit and plastic_limit are required")
    if not all(math.isfinite(value) for value in (liquid_limit, plastic_limit)):
        raise ValueError("Atterberg limits must be finite numbers")
    if liquid_limit <= plastic_limit or plastic_limit < 0:
        raise ValueError("liquid_limit must be greater than plastic_limit")

    plasticity_index = liquid_limit - plastic_limit
    # Simple empirical screening estimates, not substitutes for laboratory tests.
    estimated_omc = 5.0 + 0.25 * plasticity_index
    estimated_mdd = max(1.2, min(2.2, 2.05 - 0.006 * plasticity_index))
    return {
        "estimated_omc": round(estimated_omc, 2),
        "estimated_mdd": round(estimated_mdd, 3),
        "plasticity_index": round(plasticity_index, 2),
        "method": "Local empirical PI correlation; screening estimate only",
    }


# Retained compatibility for the legacy sample-data route and existing callers.
def find_omc_mdd(trials):
    if len(trials) < 2:
        raise ValueError("At least 2 trials are required to determine OMC and MDD")
    moisture = np.asarray([item["moisture_content"] for item in trials], dtype=float)
    density = np.asarray([item["dry_density"] for item in trials], dtype=float)
    if len(trials) >= 3:
        fit = np.polyfit(moisture, density, 2)
        a, b, c = fit
        vertex = -b / (2 * a) if a < 0 else math.nan
        if a < 0 and moisture.min() <= vertex <= moisture.max():
            return round(float(vertex), 4), round(float(np.polyval(fit, vertex)), 4), {
                "a": float(a), "b": float(b), "c": float(c)
            }
    peak = int(np.argmax(density))
    return round(float(moisture[peak]), 4), round(float(density[peak]), 4), None


def get_compaction_recommendations(moisture_content, omc, dry_density, mdd):
    ratio = (dry_density / mdd) * 100 if mdd > 0 else 0
    recommendations = []
    status = "optimal"
    if moisture_content < omc:
        status = "dry"
        recommendations.append({
            "type": "warning", "icon": "💧", "title": "Add Water",
            "message": f"Moisture content ({moisture_content:.2f}%) is below OMC ({omc:.2f}%).",
            "action": f"Increase moisture by approximately {omc - moisture_content:.2f}%",
        })
    elif moisture_content > omc:
        status = "wet"
        recommendations.append({
            "type": "warning", "icon": "🔥", "title": "Dry the Soil",
            "message": f"Moisture content ({moisture_content:.2f}%) is above OMC ({omc:.2f}%).",
            "action": f"Reduce moisture by approximately {moisture_content - omc:.2f}%",
        })
    if ratio >= 97:
        recommendations.append({
            "type": "success", "icon": "✅", "title": "Proper Compaction Achieved",
            "message": f"Dry density is {ratio:.1f}% of MDD.",
            "action": "Maintain current compaction effort",
        })
        status = "optimal"
    elif ratio >= 90:
        recommendations.append({
            "type": "info", "icon": "⚠️", "title": "Good Compaction",
            "message": f"Dry density is {ratio:.1f}% of MDD.",
            "action": "Increase compaction effort slightly",
        })
    else:
        recommendations.append({
            "type": "error", "icon": "❌", "title": "Insufficient Compaction",
            "message": f"Dry density is {ratio:.1f}% of MDD.",
            "action": "Increase compaction effort or adjust moisture content",
        })
    return recommendations, status


def process_soil_test(trials_data):
    """Legacy-compatible calculation for the sample-data endpoint."""
    processed = []
    for index, item in enumerate(trials_data, start=1):
        moisture = calculate_moisture_content(float(item["W1"]), float(item["W2"]), float(item["W3"]))
        density = calculate_dry_density(float(item["wet_density"]), moisture)
        processed.append({
            "trial_number": index,
            "W1": float(item["W1"]), "W2": float(item["W2"]), "W3": float(item["W3"]),
            "wet_density": float(item["wet_density"]),
            "moisture_content": moisture, "dry_density": density,
            "water_content_g": float(item["W2"]) - float(item["W3"]),
            "dry_soil_g": float(item["W3"]) - float(item["W1"]),
        })
    omc, mdd, fit = find_omc_mdd(processed)
    avg_moisture = float(np.mean([item["moisture_content"] for item in processed]))
    avg_density = float(np.mean([item["dry_density"] for item in processed]))
    recommendations, status = get_compaction_recommendations(avg_moisture, omc, avg_density, mdd)
    return {
        "trials": processed, "omc": omc, "mdd": mdd, "regression_fit": fit,
        "average_moisture_content": round(avg_moisture, 4),
        "average_dry_density": round(avg_density, 4),
        "recommendations": recommendations, "status": status,
        "trial_count": len(processed),
    }


def validate_trial_input(trial_data):
    """Legacy validation adapter."""
    try:
        fields = dict(trial_data)
        fields.setdefault("container_no", "1")
        TrialInput.model_validate(fields)
        return []
    except (TypeError, ValueError) as exc:
        return [str(exc)]
