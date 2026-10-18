import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import app
from calculations import (
    CalculationError,
    SoilTestRequest,
    TrialInput,
    calculate_moisture_content,
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


def test_omitted_specific_gravity_uses_default_and_null_is_rejected():
    request = SoilTestRequest.model_validate(sample_request())
    assert request.specific_gravity == 2.65

    invalid = sample_request()
    invalid["specific_gravity"] = None
    with pytest.raises(ValidationError):
        SoilTestRequest.model_validate(invalid)


@pytest.mark.parametrize("trial_count", [0, 3, 11])
def test_request_rejects_trial_counts_outside_supported_range(trial_count):
    payload = sample_request()
    payload["trials"] = (payload["trials"] * 3)[:trial_count]
    with pytest.raises(ValidationError):
        SoilTestRequest.model_validate(payload)


@pytest.mark.parametrize(("specific_gravity", "wet_density"), [(2.4, 0.8), (3.0, 3.0)])
def test_numeric_physical_boundaries_are_accepted(specific_gravity, wet_density):
    payload = sample_request()
    payload["specific_gravity"] = specific_gravity
    payload["trials"][0]["wet_density"] = wet_density
    request = SoilTestRequest.model_validate(payload)
    assert request.specific_gravity == specific_gravity
    assert request.trials[0].wet_density == wet_density


@pytest.mark.parametrize("field_name", ["W1", "W2", "W3", "wet_density"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_trial_rejects_non_finite_values_in_every_numeric_field(field_name, value):
    trial = {
        "container_no": "C-1",
        "W1": 20,
        "W2": 130,
        "W3": 120,
        "wet_density": 1.8,
    }
    trial[field_name] = value
    with pytest.raises(ValidationError):
        TrialInput.model_validate(trial)


@pytest.mark.parametrize(
    ("w2", "w3"),
    [(120, 120), (120, 121), (130, 20)],
)
def test_trial_rejects_invalid_mass_order(w2, w3):
    with pytest.raises(ValidationError):
        TrialInput(container_no="C-1", W1=20, W2=w2, W3=w3, wet_density=1.8)


def test_extreme_finite_masses_fail_as_calculation_input_error():
    with pytest.raises(CalculationError):
        calculate_moisture_content(1.0, 1e308, 2.0)


def test_calculation_rejects_less_than_three_distinct_moisture_values():
    payload = sample_request()
    for trial in payload["trials"]:
        trial["W2"] = 130.0
    with pytest.raises(CalculationError, match="three distinct moisture"):
        calculate_soil_test(SoilTestRequest.model_validate(payload))


def test_calculation_rejects_finite_but_unsupported_curve_range():
    payload = sample_request()
    payload["trials"][0].update({"W1": 1.0, "W3": 2.0, "W2": 1e200})
    with pytest.raises(CalculationError, match="curve-fitting range"):
        calculate_soil_test(SoilTestRequest.model_validate(payload))


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


def test_calculate_endpoint_returns_structured_error_for_degenerate_curve(client):
    payload = sample_request()
    for trial in payload["trials"]:
        trial["W2"] = 130.0
    response = client.post("/api/calculate", json=payload)
    assert response.status_code == 422
    assert response.get_json()["error"] == "Calculation could not be completed"


def test_calculate_endpoint_rejects_malformed_json_with_json_error(client):
    response = client.post(
        "/api/calculate",
        data="{invalid",
        content_type="application/json",
    )
    assert response.status_code == 400
    assert response.is_json
    assert response.get_json()["success"] is False


def test_calculate_endpoint_returns_json_for_oversized_request(client):
    response = client.post(
        "/api/calculate",
        data=b" " * (1024 * 1024 + 1),
        content_type="application/json",
    )
    assert response.status_code == 413
    assert response.is_json


def test_calculate_endpoint_allows_only_configured_local_cors_origins(client):
    allowed = client.get("/api/health", headers={"Origin": "http://localhost:5000"})
    disallowed = client.get("/api/health", headers={"Origin": "https://untrusted.example"})
    assert allowed.headers["Access-Control-Allow-Origin"] == "http://localhost:5000"
    assert "Access-Control-Allow-Origin" not in disallowed.headers


def test_pdf_export_returns_pdf(client):
    calculated = client.post("/api/calculate", json=sample_request()).get_json()
    response = client.post("/api/export-pdf", json=calculated)
    assert response.status_code == 200
    assert response.mimetype == "application/pdf"
    assert response.data.startswith(b"%PDF")


def test_pdf_export_escapes_untrusted_report_text(client):
    calculated = client.post("/api/calculate", json=sample_request()).get_json()
    calculated["test_name"] = "<script>alert('xss')</script>"
    response = client.post("/api/export-pdf", json=calculated)
    assert response.status_code == 200
    assert response.data.startswith(b"%PDF")


def test_pdf_export_rejects_missing_or_invalid_required_fields(client):
    response = client.post("/api/export-pdf", json={"test_name": "Incomplete"})
    assert response.status_code == 422
    assert response.is_json


def test_unexpected_api_errors_do_not_expose_internal_details(client, monkeypatch):
    import app as app_module

    def fail_calculation(_request):
        raise RuntimeError("internal-secret-detail")

    monkeypatch.setattr(app_module, "calculate_soil_test", fail_calculation)
    response = client.post("/api/calculate", json=sample_request())
    assert response.status_code == 500
    assert "internal-secret-detail" not in response.get_data(as_text=True)
    assert response.get_json()["error"] == "An unexpected server error occurred"