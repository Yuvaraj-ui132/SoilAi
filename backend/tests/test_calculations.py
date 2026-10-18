import builtins
import re
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
    calculate_dry_density,
    calculate_soil_test,
    evaluate_compaction,
    _zero_air_void_density,
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
    assert result["peak_method"] == "quadratic_fit"
    assert result["average_moisture_content"] == pytest.approx(20.0)
    assert result["average_dry_density"] == pytest.approx(1.775)
    assert result["trials"][2]["moisture_content"] == pytest.approx(20.0)
    assert result["trials"][2]["dry_density"] == pytest.approx(1.9)


def test_moisture_and_density_formulas_match_known_values():
    moisture = calculate_moisture_content(20, 140, 120)
    assert moisture == pytest.approx(20.0)
    assert calculate_dry_density(2.28, moisture) == pytest.approx(1.9)


def test_zero_air_void_density_matches_specific_gravity_relation():
    assert _zero_air_void_density(20.0, 2.65) == pytest.approx(
        2.65 / (1 + 20 * 2.65 / 100)
    )
    assert _zero_air_void_density(0.0, 2.65) == pytest.approx(2.65)


@pytest.mark.parametrize(
    ("w1", "w2", "w3"),
    [(10, 20, 10), (10, 10, 9), (10, 15, 16)],
)
def test_moisture_formula_rejects_zero_denominators_and_impossible_mass_order(w1, w2, w3):
    with pytest.raises(ValueError, match="W2 > W3 > W1"):
        calculate_moisture_content(w1, w2, w3)


def test_calculation_falls_back_to_measured_peak_when_curve_opens_upward():
    payload = sample_request()
    for trial, (moisture, density) in zip(
        payload["trials"], [(10, 1.5), (15, 1.6), (20, 1.7), (25, 1.8), (30, 1.9)]
    ):
        trial["W2"] = trial["W3"] + moisture
        trial["wet_density"] = density * (1 + moisture / 100)

    result = calculate_soil_test(SoilTestRequest.model_validate(payload))
    assert result["peak_method"] == "measured_peak_fallback"
    assert result["omc"] == pytest.approx(30.0)
    assert result["mdd"] == pytest.approx(1.9)


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


def test_health_endpoint_returns_service_status_and_utc_timestamp(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["status"] == "healthy"
    assert payload["service"] == "SoilAI local calculation API"
    assert payload["timestamp"].endswith("+00:00")


def test_sample_data_endpoint_returns_calculated_sample_shape(client):
    response = client.get("/api/sample-data")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["success"] is True
    assert payload["results"]["trial_count"] == len(payload["sample_trials"]) == 5
    assert {"omc", "mdd", "trials"} <= payload["results"].keys()


def test_calculate_endpoint_validation_error_has_field_details(client):
    invalid = sample_request()
    invalid["trials"][0]["W2"] = 120
    response = client.post("/api/calculate", json=invalid)
    assert response.status_code == 422
    assert response.get_json()["details"]
    assert any("W2" in detail["field"] for detail in response.get_json()["details"])


@pytest.mark.parametrize(
    "payload",
    [
        {"soil_type": "Silty Clay", "trials": sample_request()["trials"]},
        {**sample_request(), "trials": [{**sample_request()["trials"][0], "W2": "not-a-number"}]},
        {**sample_request(), "trials": [{**sample_request()["trials"][0], "unexpected": 1}] + sample_request()["trials"][1:]},
        [],
    ],
)
def test_calculate_endpoint_returns_structured_validation_errors(client, payload):
    response = client.post("/api/calculate", json=payload)
    assert response.status_code == 422
    body = response.get_json()
    assert body["success"] is False
    assert body["error"] == "Validation failed"
    assert body["details"]
    assert all({"field", "message", "type"} <= detail.keys() for detail in body["details"])


@pytest.mark.parametrize(
    "payload",
    [
        {**sample_request(), "specific_gravity": float("nan")},
        {**sample_request(), "trials": [{**sample_request()["trials"][0], "W1": float("inf")}] + sample_request()["trials"][1:]},
    ],
)
def test_calculate_endpoint_rejects_non_finite_json_numbers(client, payload):
    response = client.post("/api/calculate", json=payload)
    assert response.status_code == 422
    assert response.get_json()["success"] is False


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


def test_http_errors_share_json_shape_and_preserve_protocol_headers(client):
    missing = client.get("/api/not-a-route")
    assert missing.status_code == 404
    assert missing.get_json() == {"success": False, "error": "Endpoint not found"}

    wrong_method = client.post("/api/health")
    assert wrong_method.status_code == 405
    assert wrong_method.get_json() == {"success": False, "error": "Method not allowed"}
    assert "GET" in wrong_method.headers["Allow"]


def _calculated_report_payload(client):
    response = client.post("/api/calculate", json=sample_request())
    assert response.status_code == 200
    return response.get_json()


def test_pdf_export_returns_pdf(client):
    calculated = _calculated_report_payload(client)
    assert calculated["fit"]
    assert calculated["peak_method"] == "quadratic_fit"
    response = client.post("/api/export-pdf", json=calculated)
    assert response.status_code == 200
    assert response.mimetype == "application/pdf"
    assert response.data.startswith(b"%PDF")
    assert response.headers["Content-Disposition"].endswith("SoilAI_Compaction_Report.pdf")
    assert len(response.data) > 4000
    assert len(re.findall(rb"/Type\s*/Page\b", response.data)) == 2


def test_pdf_export_accepts_legacy_payload_without_curve_fit_metadata(client):
    calculated = _calculated_report_payload(client)
    calculated.pop("fit")
    calculated.pop("peak_method")

    response = client.post("/api/export-pdf", json=calculated)

    assert response.status_code == 200
    assert response.mimetype == "application/pdf"
    assert response.data.startswith(b"%PDF")
    assert len(response.data) > 4000
    assert len(re.findall(rb"/Type\s*/Page\b", response.data)) == 2


def test_pdf_export_uses_same_two_page_generator_for_view_and_download(client):
    calculated = _calculated_report_payload(client)
    download = client.post("/api/export-pdf", json=calculated)
    view = client.post("/api/export-pdf?disposition=inline", json=calculated)

    assert download.status_code == view.status_code == 200
    assert download.mimetype == view.mimetype == "application/pdf"
    assert download.headers["Content-Disposition"].startswith("attachment;")
    assert view.headers["Content-Disposition"].startswith("inline;")
    assert len(re.findall(rb"/Type\s*/Page\b", download.data)) == 2
    assert len(re.findall(rb"/Type\s*/Page\b", view.data)) == 2


def test_pdf_export_fits_complete_ten_trial_table_in_two_pages(client):
    moisture_densities = [
        (8, 1.70), (10, 1.76), (12, 1.82), (14, 1.86), (16, 1.90),
        (18, 1.92), (20, 1.91), (22, 1.88), (24, 1.83), (26, 1.78),
    ]
    payload = {
        "test_name": "Ten trial layout check",
        "soil_type": "Silty Clay",
        "trials": [],
    }
    for index, (moisture, dry_density) in enumerate(moisture_densities, start=1):
        w1, w3 = 20.0, 120.0
        payload["trials"].append({
            "container_no": f"C-{index}",
            "W1": w1,
            "W2": w3 + moisture,
            "W3": w3,
            "wet_density": dry_density * (1 + moisture / 100),
        })

    calculated = client.post("/api/calculate", json=payload).get_json()
    response = client.post("/api/export-pdf", json=calculated)

    assert response.status_code == 200
    assert len(calculated["trials"]) == 10
    assert len(re.findall(rb"/Type\s*/Page\b", response.data)) == 2


def test_pdf_export_supports_two_complete_saved_trial_observations(client):
    payload = {
        "test_name": "Two trial saved report",
        "omc": 20.0,
        "mdd": 1.9,
        "trials": [
            {
                "trial_number": 1, "W1": 20, "W2": 130, "W3": 120,
                "wet_density": 1.815, "moisture_content": 10, "dry_density": 1.65,
            },
            {
                "trial_number": 2, "W1": 20, "W2": 140, "W3": 120,
                "wet_density": 2.28, "moisture_content": 20, "dry_density": 1.9,
            },
        ],
    }

    response = client.post("/api/export-pdf", json=payload)

    assert response.status_code == 200
    assert len(re.findall(rb"/Type\s*/Page\b", response.data)) == 2


def test_pdf_export_escapes_untrusted_report_text(client):
    calculated = _calculated_report_payload(client)
    calculated["test_name"] = "<script>alert('xss')</script>"
    response = client.post("/api/export-pdf", json=calculated)
    assert response.status_code == 200
    assert response.data.startswith(b"%PDF")
    assert b"<script>" not in response.data


def test_pdf_export_rejects_missing_or_invalid_required_fields(client):
    response = client.post("/api/export-pdf", json={"test_name": "Incomplete"})
    assert response.status_code == 422
    assert response.is_json


def test_pdf_export_returns_service_unavailable_when_reportlab_is_missing(client, monkeypatch):
    original_import = builtins.__import__

    def import_without_reportlab(name, *args, **kwargs):
        if name.startswith("reportlab"):
            raise ImportError("simulated missing optional runtime")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_without_reportlab)
    response = client.post("/api/export-pdf", json=_calculated_report_payload(client))

    assert response.status_code == 503
    assert response.get_json() == {
        "success": False,
        "error": "PDF export is unavailable because ReportLab is not installed",
    }


def test_pdf_export_hides_and_logs_unexpected_generation_errors(client, monkeypatch, caplog):
    from reportlab.platypus import SimpleDocTemplate

    def fail_build(*_args, **_kwargs):
        raise RuntimeError("internal-pdf-secret")

    monkeypatch.setattr(SimpleDocTemplate, "build", fail_build)
    response = client.post("/api/export-pdf", json=_calculated_report_payload(client))

    assert response.status_code == 500
    assert response.get_json() == {
        "success": False,
        "error": "An unexpected server error occurred",
    }
    assert "internal-pdf-secret" not in response.get_data(as_text=True)
    assert "internal-pdf-secret" in caplog.text


def test_unexpected_api_errors_do_not_expose_internal_details(client, monkeypatch):
    import app as app_module

    def fail_calculation(_request):
        raise RuntimeError("internal-secret-detail")

    monkeypatch.setattr(app_module, "calculate_soil_test", fail_calculation)
    response = client.post("/api/calculate", json=sample_request())
    assert response.status_code == 500
    assert "internal-secret-detail" not in response.get_data(as_text=True)
    assert response.get_json() == {
        "success": False,
        "error": "An unexpected server error occurred",
    }