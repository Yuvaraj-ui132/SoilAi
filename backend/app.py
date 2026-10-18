"""Local-first Flask API for SoilAI calculations and engineering reports."""

import io
import logging
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from xml.sax.saxutils import escape

from flask import Flask, jsonify, request, send_file, send_from_directory
from flask_cors import CORS
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from werkzeug.exceptions import HTTPException

from calculations import (
    CalculationError,
    SoilTestRequest,
    calculate_soil_test,
    process_soil_test,
)
from ml_engine import (
    MODEL_BUNDLE,
    predict_compaction_parameters,
)

LOGGER = logging.getLogger(__name__)
ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"
app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024


def _get_cors_origins() -> list[str]:
    configured_origins = os.environ.get("SOILAI_CORS_ORIGINS")
    if configured_origins is None:
        return ["http://127.0.0.1:5000", "http://localhost:5000"]

    origins = [origin.strip() for origin in configured_origins.split(",") if origin.strip()]
    for origin in origins:
        parsed = urlsplit(origin)
        if (
            origin == "*"
            or parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise RuntimeError(
                "SOILAI_CORS_ORIGINS must contain comma-separated HTTP(S) origins, not paths or wildcards"
            )
    return origins


CORS(app, resources={r"/api/*": {"origins": _get_cors_origins()}})


class MLPredictionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    liquid_limit: float = Field(ge=15.0, le=100.0, description="Liquid Limit (%)")
    plastic_limit: float = Field(ge=10.0, le=60.0, description="Plastic Limit (%)")

    @model_validator(mode="after")
    def validate_limit_order(self):
        if self.liquid_limit <= self.plastic_limit:
            raise ValueError("liquid_limit must be greater than plastic_limit")
        return self


class ModelConfidence(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    omc_r2: float
    omc_mae: float
    mdd_r2: float
    mdd_mae: float


class MLPredictionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    predicted_omc: float
    predicted_mdd: float
    plasticity_index: float
    uscs_classification: str
    verdict: dict[str, str]
    model_confidence: ModelConfidence
    model_metrics_note: str


class ReportTrial(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    container_no: str = Field(min_length=1, max_length=40)
    W1: float
    W2: float
    W3: float
    wet_density: float = Field(ge=0.8, le=3.0)
    moisture_content: float
    dry_density: float

    @model_validator(mode="after")
    def validate_finite_values(self):
        values = (
            self.W1, self.W2, self.W3, self.wet_density,
            self.moisture_content, self.dry_density,
        )
        if not all(math.isfinite(value) for value in values):
            raise ValueError("Report values must be finite numbers")
        if not self.W2 > self.W3 > self.W1:
            raise ValueError("Report masses must satisfy W2 > W3 > W1")
        return self


class ReportRequest(BaseModel):
    model_config = ConfigDict(extra="allow", allow_inf_nan=False)
    test_name: str = Field(min_length=1, max_length=120)
    soil_type: str = Field(min_length=1, max_length=80)
    trials: list[ReportTrial] = Field(min_length=4, max_length=10)
    omc: float
    mdd: float
    evaluation: dict

    @model_validator(mode="after")
    def validate_summary_values(self):
        if not all(math.isfinite(value) for value in (self.omc, self.mdd)):
            raise ValueError("Report summary values must be finite numbers")
        if self.mdd <= 0:
            raise ValueError("MDD must be positive")
        return self


@app.errorhandler(ValidationError)
def handle_validation_error(error):
    return jsonify({
        "success": False,
        "error": "Validation failed",
        "details": [
            {
                "field": ".".join(str(part) for part in item["loc"]) or error.title,
                "message": item["msg"],
                "type": item["type"],
            }
            for item in error.errors()
        ],
    }), 422


@app.errorhandler(CalculationError)
def handle_calculation_error(error):
    return jsonify({
        "success": False,
        "error": "Calculation could not be completed",
        "details": [{"field": "trials", "message": str(error)}],
    }), 422


@app.errorhandler(HTTPException)
def handle_http_error(error):
    message = error.description if error.code and error.code < 500 else "Request failed"
    return jsonify({"success": False, "error": message}), error.code or 500


@app.errorhandler(Exception)
def handle_unexpected_error(error):
    LOGGER.exception("Unhandled SoilAI request error")
    return jsonify({
        "success": False,
        "error": "An unexpected server error occurred",
    }), 500


@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/signup")
def signup():
    return send_from_directory(FRONTEND_DIR, "signup.html")


@app.route("/forgot-password")
def forgot_password():
    return send_from_directory(FRONTEND_DIR, "forgot-password.html")


@app.route("/dashboard")
def dashboard():
    return send_from_directory(FRONTEND_DIR, "dashboard.html")


@app.route("/soil-test")
def soil_test():
    return send_from_directory(FRONTEND_DIR, "soil-test.html")


@app.route("/moisture")
def moisture():
    return send_from_directory(FRONTEND_DIR, "moisture.html")


@app.route("/proctor")
def proctor():
    return send_from_directory(FRONTEND_DIR, "proctor.html")


@app.route("/reports")
def reports():
    return send_from_directory(FRONTEND_DIR, "reports.html")


@app.route("/compare")
def compare():
    return send_from_directory(FRONTEND_DIR, "compare.html")


@app.post("/api/calculate")
def calculate():
    body = request.get_json(silent=True)
    if body is None:
        return jsonify({"success": False, "error": "A JSON request body is required"}), 400
    validated = SoilTestRequest.model_validate(body)
    return jsonify({"success": True, **calculate_soil_test(validated)})


@app.post("/api/predict")
def predict():
    body = request.get_json(silent=True)
    if body is None:
        return jsonify({"success": False, "error": "A JSON request body is required"}), 400
    values = MLPredictionRequest.model_validate(body)
    result = predict_compaction_parameters(
        values.liquid_limit, values.plastic_limit, MODEL_BUNDLE
    )
    response = MLPredictionResponse.model_validate(result)
    return jsonify({"success": True, **response.model_dump()})


@app.post("/api/export-pdf")
def export_pdf():
    body = request.get_json(silent=True)
    if body is None:
        return jsonify({"success": False, "error": "A JSON request body is required"}), 400
    report = ReportRequest.model_validate(body)

    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
        )
    except ImportError:
        return jsonify({
            "success": False,
            "error": "PDF export is unavailable because ReportLab is not installed",
        }), 503

    output = io.BytesIO()
    document = SimpleDocTemplate(
        output, pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm,
        topMargin=18 * mm, bottomMargin=18 * mm,
        title=f"SoilAI Report - {report.test_name}",
    )
    styles = getSampleStyleSheet()
    story = [
        Paragraph("SoilAI Cloud Lab — Compaction Report", styles["Title"]),
        Paragraph("ASTM D698 / IS 2720 · Standard Proctor Test", styles["Heading2"]),
        Paragraph(f"Test: {escape(report.test_name)}", styles["BodyText"]),
        Paragraph(f"Soil type: {escape(report.soil_type)}", styles["BodyText"]),
        Paragraph(
            f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
            styles["BodyText"],
        ),
        Spacer(1, 6 * mm),
    ]

    rows = [["Container", "W1 (g)", "W2 (g)", "W3 (g)", "Wet density", "MC (%)", "Dry density"]]
    for index, trial in enumerate(report.trials, start=1):
        rows.append([
            str(trial.container_no or index),
            f"{trial.W1:.2f}",
            f"{trial.W2:.2f}",
            f"{trial.W3:.2f}",
            f"{trial.wet_density:.3f}",
            f"{trial.moisture_content:.2f}",
            f"{trial.dry_density:.3f}",
        ])
    table = Table(rows, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e3a5f")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#9aa9bb")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#edf3f8")]),
        ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.extend([
        table,
        Spacer(1, 8 * mm),
        Paragraph("Engineering Summary", styles["Heading2"]),
        Paragraph(f"OMC: {report.omc:.2f}%", styles["BodyText"]),
        Paragraph(f"MDD: {report.mdd:.3f} g/cm³", styles["BodyText"]),
        Paragraph(
            f"Subgrade suitability: {escape(str(report.evaluation.get('subgrade_suitability', 'Not available')))}",
            styles["BodyText"],
        ),
        Paragraph(
            f"Moisture control window: {escape(str(report.evaluation.get('moisture_control_window', 'Not available')))}",
            styles["BodyText"],
        ),
    ])
    document.build(story)
    output.seek(0)
    return send_file(
        output, mimetype="application/pdf", as_attachment=True,
        download_name="SoilAI_Compaction_Report.pdf",
    )


@app.get("/api/health")
def health():
    return jsonify({
        "status": "healthy",
        "service": "SoilAI local calculation API",
        "version": "2.0.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


@app.get("/api/system-info")
def system_info():
    return jsonify({
        "system": "SoilAI Cloud Lab",
        "architecture": "Flask calculation API with local soil screening and Firebase-backed cloud pages",
        "tiers": {
            "presentation": "HTML5/CSS3/Vanilla JS",
            "application": "Flask REST API",
            "numerical_engine": "NumPy polynomial fitting",
            "estimator": "Local Random Forest trained on synthetic data; screening only",
        },
    })


@app.get("/api/sample-data")
def sample_data():
    sample_trials = [
        {"W1": 25.0, "W2": 162.5, "W3": 150.0, "wet_density": 1.87},
        {"W1": 25.0, "W2": 165.0, "W3": 150.0, "wet_density": 2.07},
        {"W1": 25.0, "W2": 167.5, "W3": 150.0, "wet_density": 2.19},
        {"W1": 25.0, "W2": 170.0, "W3": 150.0, "wet_density": 2.18},
        {"W1": 25.0, "W2": 172.5, "W3": 150.0, "wet_density": 2.065},
    ]
    results = process_soil_test(sample_trials)
    return jsonify({"success": True, "sample_trials": sample_trials, "results": results})


@app.errorhandler(404)
def not_found(_error):
    return jsonify({"success": False, "error": "Endpoint not found"}), 404


@app.errorhandler(405)
def method_not_allowed(_error):
    return jsonify({"success": False, "error": "Method not allowed"}), 405


if __name__ == "__main__":
    host = os.environ.get("SOILAI_HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", os.environ.get("SOILAI_PORT", "5000")))
    debug = os.environ.get("SOILAI_DEBUG", "false").strip().lower() in {"1", "true", "yes"}
    app.run(debug=debug, host=host, port=port)
