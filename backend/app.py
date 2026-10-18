"""Local-first Flask API for SoilAI calculations and engineering reports."""

import io
import logging
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
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


def _error_payload(
    message: str, details: list[dict[str, str]] | None = None
) -> dict[str, object]:
    payload = {"success": False, "error": message}
    if details is not None:
        payload["details"] = details
    return payload


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

    container_no: str | None = Field(default=None, max_length=40)
    trial_number: int | None = Field(default=None, ge=1)
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


class ReportCurveFit(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    a: float
    b: float
    c: float
    r_squared: float


class ReportRequest(BaseModel):
    model_config = ConfigDict(extra="allow", allow_inf_nan=False)
    test_name: str | None = Field(default=None, max_length=120)
    soil_type: str | None = Field(default=None, max_length=80)
    location: str | None = Field(default=None, max_length=160)
    test_id: str | None = Field(default=None, max_length=120)
    test_date: datetime | None = None
    trials: list[ReportTrial] = Field(min_length=2, max_length=10)
    omc: float
    mdd: float
    evaluation: dict = Field(default_factory=dict)
    fit: ReportCurveFit | None = None
    peak_method: Literal["quadratic_fit", "measured_peak_fallback"] | None = None

    @model_validator(mode="after")
    def validate_summary_values(self):
        if not all(math.isfinite(value) for value in (self.omc, self.mdd)):
            raise ValueError("Report summary values must be finite numbers")
        if self.mdd <= 0:
            raise ValueError("MDD must be positive")
        return self


@app.errorhandler(ValidationError)
def handle_validation_error(error):
    return jsonify(_error_payload(
        "Validation failed",
        [
            {
                "field": ".".join(str(part) for part in item["loc"]) or error.title,
                "message": item["msg"],
                "type": item["type"],
            }
            for item in error.errors()
        ],
    )), 422


@app.errorhandler(CalculationError)
def handle_calculation_error(error):
    return jsonify(_error_payload(
        "Calculation could not be completed",
        [{"field": "trials", "message": str(error)}],
    )), 422


@app.errorhandler(HTTPException)
def handle_http_error(error):
    messages = {
        404: "Endpoint not found",
        405: "Method not allowed",
        413: "Request body is too large",
    }
    message = messages.get(
        error.code,
        error.description if error.code and error.code < 500 else "Request failed",
    )
    response = error.get_response()
    response.set_data(jsonify(_error_payload(message)).get_data())
    response.content_type = "application/json"
    return response


@app.errorhandler(Exception)
def handle_unexpected_error(error):
    LOGGER.exception("Unhandled SoilAI request error")
    return jsonify(_error_payload("An unexpected server error occurred")), 500


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
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.pdfbase.pdfmetrics import stringWidth
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
            Flowable,
        )
    except ImportError:
        return jsonify({
            "success": False,
            "error": "PDF export is unavailable because ReportLab is not installed",
        }), 503

    class CompactionChart(Flowable):
        def __init__(self, trials, fit, omc, mdd):
            super().__init__()
            self.width = 174 * mm
            self.height = 92 * mm
            self.trials = trials
            self.fit = fit
            self.omc = omc
            self.mdd = mdd

        def draw(self):
            canvas = self.canv
            left, bottom, width, height = 18 * mm, 14 * mm, 144 * mm, 62 * mm
            x_values = [trial.moisture_content for trial in self.trials]
            curve_min = min(x_values)
            curve_max = max(x_values)
            curve_points = 80
            curve_values = []
            if self.fit is not None:
                curve_values = [
                    self.fit.a * moisture * moisture + self.fit.b * moisture + self.fit.c
                    for moisture in (
                        curve_min + (curve_max - curve_min) * index / curve_points
                        for index in range(curve_points + 1)
                    )
                ]
            y_values = [trial.dry_density for trial in self.trials]
            x_min = min(min(x_values), self.omc) - 2
            x_max = max(max(x_values), self.omc) + 2
            visible_y_values = y_values + [self.mdd] + curve_values
            y_min = max(0.0, min(visible_y_values) - 0.15)
            y_max = max(visible_y_values) + 0.15
            if x_max <= x_min:
                x_max = x_min + 1
            if y_max <= y_min:
                y_max = y_min + 0.1
            def x_map(value):
                return left + (value - x_min) * width / (x_max - x_min)

            def y_map(value):
                return bottom + (value - y_min) * height / (y_max - y_min)

            canvas.setStrokeColor(colors.HexColor("#dce6dc"))
            canvas.setLineWidth(0.5)
            for step in range(6):
                x = left + width * step / 5
                y = bottom + height * step / 5
                canvas.line(x, bottom, x, bottom + height)
                canvas.line(left, y, left + width, y)

            canvas.setStrokeColor(colors.HexColor("#526358"))
            canvas.setLineWidth(0.9)
            canvas.line(left, bottom, left + width, bottom)
            canvas.line(left, bottom, left, bottom + height)
            canvas.setFont("Helvetica", 7)
            canvas.setFillColor(colors.HexColor("#526358"))
            for step in range(6):
                x_value = x_min + (x_max - x_min) * step / 5
                y_value = y_min + (y_max - y_min) * step / 5
                x = left + width * step / 5
                y = bottom + height * step / 5
                canvas.drawCentredString(x, bottom - 10, f"{x_value:.1f}")
                canvas.drawRightString(left - 4, y - 2, f"{y_value:.3f}")
            canvas.setFont("Helvetica-Bold", 8)
            canvas.drawCentredString(left + width / 2, 1 * mm, "Moisture content (%)")
            canvas.saveState()
            canvas.translate(3 * mm, bottom + height / 2)
            canvas.rotate(90)
            canvas.drawCentredString(0, 0, "Dry density (g/cm³)")
            canvas.restoreState()

            if self.fit is not None:
                canvas.setStrokeColor(colors.HexColor("#496b52"))
                canvas.setLineWidth(1.8)
                path = canvas.beginPath()
                for index in range(curve_points + 1):
                    moisture = curve_min + (curve_max - curve_min) * index / curve_points
                    density = (
                        self.fit.a * moisture * moisture
                        + self.fit.b * moisture
                        + self.fit.c
                    )
                    px, py = x_map(moisture), y_map(density)
                    if index == 0:
                        path.moveTo(px, py)
                    else:
                        path.lineTo(px, py)
                canvas.drawPath(path)

            canvas.setFillColor(colors.HexColor("#294735"))
            for moisture, density in zip(x_values, y_values):
                canvas.circle(x_map(moisture), y_map(density), 2.6, stroke=0, fill=1)

            peak_x, peak_y = x_map(self.omc), y_map(self.mdd)
            canvas.setFillColor(colors.HexColor("#9a6a2f"))
            canvas.circle(peak_x, peak_y, 4, stroke=0, fill=1)
            canvas.setStrokeColor(colors.HexColor("#9a6a2f"))
            canvas.setDash(2, 2)
            canvas.line(peak_x, bottom, peak_x, peak_y)
            canvas.setDash()
            label = f"OMC {self.omc:.2f}% | MDD {self.mdd:.3f} g/cm³"
            canvas.setFont("Helvetica-Bold", 7)
            canvas.setFillColor(colors.HexColor("#294735"))
            label_x = min(max(peak_x + 5, left + 3), left + width - stringWidth(label, "Helvetica-Bold", 7))
            label_y = min(peak_y + 7, bottom + height - 8)
            canvas.drawString(label_x, label_y, label)
            canvas.setFont("Helvetica", 7)
            canvas.setFillColor(colors.HexColor("#526358"))
            canvas.drawString(left, bottom + height + 5, "Measured trials")
            if self.fit is not None:
                canvas.setFillColor(colors.HexColor("#496b52"))
                canvas.drawString(left + 25 * mm, bottom + height + 5, "Quadratic fit")
            canvas.setFillColor(colors.HexColor("#9a6a2f"))
            peak_legend_x = left + (48 if self.fit is not None else 25) * mm
            canvas.drawString(peak_legend_x, bottom + height + 5, "Reported peak")

    output = io.BytesIO()
    page_width, page_height = A4
    generated_at = datetime.now(timezone.utc)
    document = SimpleDocTemplate(
        output, pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm,
        topMargin=24 * mm, bottomMargin=20 * mm,
        title=f"SoilAI Report - {escape(report.test_name or 'Standard Proctor Compaction Test')}",
        author="SoilAI Cloud Lab",
    )
    styles = getSampleStyleSheet()
    forest = colors.HexColor("#294735")
    muted = colors.HexColor("#526358")
    sage = colors.HexColor("#dce6dc")
    pale_sage = colors.HexColor("#edf3eb")
    styles.add(ParagraphStyle(
        name="ReportTitle", parent=styles["Title"], fontName="Helvetica-Bold",
        fontSize=20, leading=24, textColor=forest, alignment=0, spaceAfter=3 * mm,
    ))
    styles.add(ParagraphStyle(
        name="ReportMetric", parent=styles["Title"], fontName="Helvetica-Bold",
        fontSize=17, leading=20, textColor=forest, alignment=0, spaceAfter=0,
    ))
    styles.add(ParagraphStyle(
        name="ReportSubtitle", parent=styles["Normal"], fontSize=9,
        leading=13, textColor=muted, spaceAfter=5 * mm,
    ))
    styles.add(ParagraphStyle(
        name="ReportSection", parent=styles["Heading2"], fontName="Helvetica-Bold",
        fontSize=12, leading=15, textColor=forest, spaceBefore=3 * mm, spaceAfter=2 * mm,
    ))
    styles.add(ParagraphStyle(
        name="ReportBody", parent=styles["BodyText"], fontSize=8.5,
        leading=12, textColor=muted, spaceAfter=2 * mm,
    ))
    styles.add(ParagraphStyle(
        name="TableHeader", parent=styles["BodyText"], fontName="Helvetica-Bold",
        fontSize=7, leading=8, textColor=colors.white, alignment=1,
    ))
    styles.add(ParagraphStyle(
        name="MetadataLabel", parent=styles["BodyText"], fontName="Helvetica-Bold",
        fontSize=7, leading=9, textColor=muted,
    ))
    styles.add(ParagraphStyle(
        name="MetadataValue", parent=styles["BodyText"], fontSize=8.5,
        leading=11, textColor=forest, wordWrap="CJK",
    ))
    styles.add(ParagraphStyle(
        name="ReportTableCell", parent=styles["ReportBody"], wordWrap="CJK",
    ))

    def paragraph(text, style="ReportBody"):
        return Paragraph(escape(str(text)).replace("\n", "<br/>"), styles[style])

    def draw_page(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(sage)
        canvas.setLineWidth(0.6)
        canvas.line(18 * mm, page_height - 17 * mm, page_width - 18 * mm, page_height - 17 * mm)
        canvas.setFont("Helvetica-Bold", 7.5)
        canvas.setFillColor(forest)
        canvas.drawString(18 * mm, page_height - 13 * mm, "SOILAI CLOUD LAB")
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(muted)
        canvas.drawRightString(page_width - 18 * mm, page_height - 13 * mm, "COMPACTION TEST REPORT")
        canvas.line(18 * mm, 14 * mm, page_width - 18 * mm, 14 * mm)
        canvas.drawString(
            18 * mm,
            9 * mm,
            f"Generated {generated_at.strftime('%d %b %Y, %H:%M UTC')} - Verify source observations",
        )
        canvas.drawRightString(page_width - 18 * mm, 9 * mm, f"Page {doc.page}")
        canvas.restoreState()

    if report.test_date is None:
        test_date = "Not recorded"
    elif report.test_date.tzinfo is None:
        test_date = report.test_date.strftime("%d %b %Y, %H:%M (timezone not recorded)")
    else:
        test_date = report.test_date.astimezone(timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    metadata = [
        [paragraph("TEST NAME", "MetadataLabel"), paragraph(report.test_name or "Not recorded", "MetadataValue"),
         paragraph("", "MetadataLabel"), paragraph("", "MetadataValue")],
        [paragraph("TEST ID", "MetadataLabel"), paragraph(report.test_id or "Not assigned", "MetadataValue"),
         paragraph("TEST DATE", "MetadataLabel"), paragraph(test_date, "MetadataValue")],
        [paragraph("TRIALS", "MetadataLabel"), paragraph(len(report.trials), "MetadataValue"),
         paragraph("SITE / LOCATION", "MetadataLabel"), paragraph(report.location or "Not recorded", "MetadataValue")],
        [paragraph("SOIL TYPE", "MetadataLabel"), paragraph(report.soil_type or "Not recorded", "MetadataValue"),
         paragraph("", "MetadataLabel"), paragraph("", "MetadataValue")],
    ]
    metadata_table = Table(metadata, colWidths=[25 * mm, 62 * mm, 25 * mm, 62 * mm])
    metadata_table.setStyle(TableStyle([
        ("SPAN", (1, 0), (3, 0)),
        ("BACKGROUND", (0, 0), (-1, -1), pale_sage),
        ("BOX", (0, 0), (-1, -1), 0.6, sage),
        ("INNERGRID", (0, 0), (-1, -1), 0.35, sage),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))

    summary = Table([
        [paragraph("OPTIMUM MOISTURE CONTENT", "MetadataLabel"),
         paragraph("MAXIMUM DRY DENSITY", "MetadataLabel")],
        [paragraph(f"{report.omc:.2f} %", "ReportMetric"),
         paragraph(f"{report.mdd:.3f} g/cm³", "ReportMetric")],
    ], colWidths=[87 * mm, 87 * mm])
    summary.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("BOX", (0, 0), (-1, -1), 0.7, sage),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, sage),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))

    peak_method_label = {
        "quadratic_fit": "quadratic fit",
        "measured_peak_fallback": "measured peak fallback",
    }.get(report.peak_method, "not specified in the request")
    curve_fit_note = (
        f"Curve fit R²: {report.fit.r_squared:.3f}. "
        f"Peak method: {peak_method_label}."
        if report.fit is not None
        else "Curve fit details were not supplied. The chart shows measured trial points and the reported OMC/MDD only."
    )
    methodology_note = (
        "A quadratic curve is fitted to the calculated trial moisture-content and dry-density pairs. "
        "When the fitted curve is concave and its vertex lies within the measured moisture range, "
        "the vertex is reported as OMC/MDD. Otherwise, the measured trial with the greatest dry "
        "density is reported. No calculation formula or returned result is recomputed for this report."
        if report.fit is not None
        else
        "The request did not include curve-fit details. OMC and MDD in this report are the supplied "
        "calculation results; no curve fit or peak-selection method is inferred or recomputed."
    )

    story = [
        paragraph("Standard Proctor Compaction Test", "ReportTitle"),
        paragraph("Measured trial observations and calculated compaction parameters", "ReportSubtitle"),
        metadata_table,
        Spacer(1, 4 * mm),
        paragraph("Executive summary", "ReportSection"),
        paragraph(
            f"The supplied trial data produce an OMC of {report.omc:.2f}% and an MDD of "
            f"{report.mdd:.3f} g/cm³. The peak method was {peak_method_label}. "
            "These are calculated results from the submitted observations; this report does not certify "
            "test execution, field suitability, or acceptance.",
        ),
        summary,
        Spacer(1, 3 * mm),
        paragraph("Trial observations", "ReportSection"),
        paragraph(
            "All reported values are taken from the saved test. Masses are in grams; "
            "density values are in g/cm³; moisture content is in percent.",
        ),
    ]

    header = [
        "Container / trial",
        "W1<br/>(g)",
        "W2<br/>(g)",
        "W3<br/>(g)",
        "Wet density<br/>(g/cm³)",
        "MC<br/>(%)",
        "Dry density<br/>(g/cm³)",
    ]
    rows = [[Paragraph(value, styles["TableHeader"]) for value in header]]
    for trial in report.trials:
        rows.append([
            Paragraph(
                escape(trial.container_no or (
                    f"Trial {trial.trial_number}" if trial.trial_number is not None else "Not recorded"
                )),
                styles["ReportTableCell"],
            ),
            f"{trial.W1:.2f}",
            f"{trial.W2:.2f}",
            f"{trial.W3:.2f}",
            f"{trial.wet_density:.3f}",
            f"{trial.moisture_content:.2f}",
            f"{trial.dry_density:.3f}",
        ])
    table = Table(rows, colWidths=[22 * mm, 19 * mm, 19 * mm, 19 * mm, 31 * mm, 22 * mm, 42 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), forest),
        ("TEXTCOLOR", (0, 1), (-1, -1), forest),
        ("GRID", (0, 0), (-1, -1), 0.4, sage),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, pale_sage]),
        ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("FONTSIZE", (0, 1), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.extend([
        table,
        PageBreak(),
        paragraph("Compaction curve", "ReportSection"),
        CompactionChart(report.trials, report.fit, report.omc, report.mdd),
        paragraph(curve_fit_note),
        paragraph("Calculation methodology", "ReportSection"),
        paragraph("Moisture content, MC (%) = (W2 - W3) / (W3 - W1) x 100"),
        paragraph("Dry density (g/cm³) = wet density / (1 + MC / 100)"),
        paragraph(methodology_note),
        paragraph("Test procedure and standard", "ReportSection"),
        paragraph(
            "The application’s Standard Proctor module is labelled IS 2720 (Part 7). The saved test "
            "does not record procedure execution, operator details, or equipment calibration. This "
            "report does not independently verify compliance or certify test performance.",
        ),
        paragraph("Interpretation and limitations", "ReportSection"),
        paragraph(
            "OMC and MDD summarize the submitted laboratory trial values and the stated peak-selection "
            "method. Results depend on the accuracy and representativeness of those inputs. The report "
            "does not establish material classification, field compaction acceptance, or suitability for "
            "a construction purpose.",
        ),
    ])
    document.build(story, onFirstPage=draw_page, onLaterPages=draw_page)
    output.seek(0)
    return send_file(
        output,
        mimetype="application/pdf",
        as_attachment=request.args.get("disposition") != "inline",
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


if __name__ == "__main__":
    host = os.environ.get("SOILAI_HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", os.environ.get("SOILAI_PORT", "5000")))
    debug = os.environ.get("SOILAI_DEBUG", "false").strip().lower() in {"1", "true", "yes"}
    app.run(debug=debug, host=host, port=port)
