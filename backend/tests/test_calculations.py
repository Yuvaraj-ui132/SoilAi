import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import app
from calculations import (
    SoilTestRequest,
    TrialInput,
    calculate_soil_test,
    evaluate_compaction,
)


def sample_request():
    points = [(10, 1.65), (15, 1.8375), (20, 1.9), (25, 1.8375), (30, 1.65)]
    trials = []
    for index, (moisture, dry_density) in enumerate(points, start=1):
        w1 = 20.0
        w3 = 120.0
        w2 = w3 + moisture
        wet_density = dry_density * (1.0 + moisture / 100.0)
        trials.append({
            "container_no": f"C-{index}",
            "W1": w1,
            "W2": w2,
            "W3": w3,
            "wet_density": wet_density,
        })
    return {
        "test_name": "Known peak test",
        "soil_type": "Silty Clay",
        "trials": trials,
    }


def test_valid_calculation_recovers_peak_within_one_percent():
    result = calculate_soil_test(SoilTestRequest.model_validate(sample_request()))
    assert result["omc"] == pytest.approx(20.0, rel=0.01)
    assert result["mdd"] == pytest.approx(1.9, rel=0.01)
    assert result["fit"]["r_squared"] == pytest.approx(1.0)
    assert result["zav_curve"]


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_trial_rejects_non_finite_numbers(value):
    with pytest.raises(ValidationError):
        TrialInput(container_no="C-1", W1=20, W2=value, W3=120, wet_density=1.8)


@pytest.mark.parametrize(
    ("w2", "w3"),
    [(120, 120), (120, 121), (130, 20)],
)
def test_trial_rejects_invalid_mass_order(w2, w3):
    with pytest.raises(ValidationError):
        TrialInput(container_no="C-1", W1=20, W2=w2, W3=w3, wet_density=1.8)


def test_standards_evaluation_thresholds_and_equipment():
    assert evaluate_compaction(12.0, 1.81, "Sandy Gravel") == {
        "subgrade_suitability": "Excellent",
        "moisture_control_window": "10.0% to 13.0%",
        "recommended_equipment": "Smooth-wheel / Vibratory roller",
    }
    assert evaluate_compaction(12.0, 1.65, "Lean Clay")["subgrade_suitability"] == "Fair"
    assert evaluate_compaction(12.0, 1.49, "Lean Clay")["subgrade_suitability"] == "Poor"
    assert evaluate_compaction(12.0, 1.65, "Lean Clay")["recommended_equipment"] == "Sheepsfoot / Tamping roller"


@pytest.fixture()
def client():
    app.config.update(TESTING=True)
    with app.test_client() as test_client:
        yield test_client


def test_calculate_endpoint_success(client):
    response = client.post("/api/calculate", json=sample_request())
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["success"] is True
    assert payload["omc"] == pytest.approx(20.0, rel=0.01)
    assert payload["mdd"] == pytest.approx(1.9, rel=0.01)
    assert len(payload["trials"]) == 5


def test_calculate_endpoint_validation_error_has_field_details(client):
    invalid = sample_request()
    invalid["trials"][0]["W2"] = 120
    response = client.post("/api/calculate", json=invalid)
    assert response.status_code == 422
    assert response.get_json()["details"]
    assert any("W2" in detail["field"] for detail in response.get_json()["details"])


def test_pdf_export_returns_pdf(client):
    pytest.importorskip("reportlab")
    calculated = client.post("/api/calculate", json=sample_request()).get_json()
    response = client.post("/api/export-pdf", json=calculated)
    assert response.status_code == 200
    assert response.mimetype == "application/pdf"
    assert response.data.startswith(b"%PDF")