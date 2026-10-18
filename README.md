# SoilAI Cloud Lab 🧪

**Geotechnical Proctor Analysis and Soil Screening Application**

---

## Overview

SoilAI combines a Flask geotechnical calculation API with an HTML/CSS/JavaScript
frontend. The local Soil Test workflow validates Proctor trials on the server,
calculates compaction results, screens Atterberg limits with a local model, and
can generate PDF reports. Authentication, saved Proctor records, dashboards,
moisture history, reports, and comparison pages use Firebase Authentication and
Cloud Firestore and require network access to Firebase.

---

## Features

| Feature | Description |
|---|---|
| 🔐 Auth | Firebase login, signup, forgot password |
| 🧪 Soil Test | Proctor trial input, demo presets, and live MC/DD preview |
| ⚡ Calculations | Validated server-side moisture, density, curve-fit, and ZAV calculations |
| 🤖 Soil screening | Local Random Forest estimator and deterministic USCS/rules output |
| 📊 Charts | Moisture Content vs Dry Density curve, fitted curve, and ZAV boundary |
| ☁️ Cloud features | Firebase Authentication and owner-scoped Firestore records |
| 📄 PDF Reports | Local backend-generated Proctor PDF; Firebase report pages retain jsPDF |

---

## Formulas

```
Moisture Content (%) = ((W2 - W3) / (W3 - W1)) × 100

Dry Density (g/cm³)  = Wet Density / (1 + MC / 100)

OMC  = Peak moisture from a concave quadratic fit when its vertex is in range;
       otherwise the moisture content of the measured maximum-density trial
MDD  = Dry density at the selected OMC
```

## Proctor Trial Input Validation

The local Proctor calculation API validates trial data with Pydantic v2 before
running geotechnical calculations:

- Each trial includes a container number, tare mass (`W1`), wet mass (`W2`),
  dry mass (`W3`), and wet density.
- All numeric trial values must be finite. Masses must satisfy
  `W2 > W3 > W1`, and `W1` must be greater than zero.
- Wet density must be between `0.8` and `3.0 g/cm³`, inclusive.
- A soil test must contain between 4 and 10 trials. Specific gravity defaults
  to `2.65` and must be between `2.4` and `3.0`, inclusive.
- Legacy Python callers can use `validate_trial_input(trial_data)`, which
  validates the input through the same `TrialInput` Pydantic model and returns
  an empty list when valid or validation messages when invalid.

---

## Project Structure

```
SoilAI/
├── backend/
│   ├── app.py              # Flask REST API
│   ├── calculations.py     # Core geotechnical engine
│   ├── ml_engine.py        # Local synthetic-data model and soil verdict rules
│   ├── requirements.txt    # Runtime Python dependencies
│   ├── requirements-dev.txt # Test and lint dependencies
│   └── tests/              # Backend regression tests
├── frontend/
│   ├── index.html          # Login page
│   ├── signup.html         # Signup page
│   ├── forgot-password.html
│   ├── dashboard.html      # Analytics dashboard
│   ├── soil-test.html      # Test input + results
│   ├── reports.html        # Reports listing
│   ├── css/
│   │   ├── main.css        # Global design system
│   │   ├── auth.css        # Auth pages
│   │   └── dashboard.css   # Dashboard & test pages
│   └── js/
│       ├── firebase-config.js  # Firebase init & config
│       ├── auth.js             # Authentication logic
│       ├── dashboard.js        # Real-time dashboard
│       ├── soil-test.js        # Test input & PDF
│       └── charts.js           # Chart.js integration
├── firestore.rules         # Version-controlled Firestore access policy
├── firebase.json           # Firebase Hosting and Firestore configuration
├── Dockerfile              # Flask API container
└── README.md
```

---

## Setup & Running

### 1. Install Python Dependencies

For local development and tests, create a virtual environment and install
runtime and development dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
```

On macOS/Linux, use `python3 -m venv .venv` and
`./.venv/bin/python -m pip install -r backend/requirements-dev.txt`.

### 2. Run the Flask Server

```bash
.\.venv\Scripts\python.exe backend\app.py
```

On macOS/Linux, use `./.venv/bin/python backend/app.py`. The server starts at
**http://127.0.0.1:5000** with debug mode off. Supported
settings:

| Variable | Default | Purpose |
|---|---|---|
| `SOILAI_HOST` | `127.0.0.1` | Flask development-server bind address |
| `SOILAI_PORT` | `5000` | Development port, unless `PORT` is set |
| `PORT` | unset | Port used by Flask when supplied; also used by Cloud Run/Gunicorn |
| `SOILAI_DEBUG` | `false` | Development-only Flask debug switch |
| `SOILAI_CORS_ORIGINS` | localhost origins | Comma-separated explicit HTTP(S) origins allowed by the API; wildcards and URL paths are rejected |
| `SOILAI_MODEL_PATH` | `backend/models/soil_rf.joblib` | Local model cache path; Docker uses `/tmp/soilai/soil_rf.joblib` |

### 3. Open the App

Visit **http://127.0.0.1:5000/soil-test**. When served by Flask, the Soil Test
page uses same-origin API requests, server-side calculations, local model
inference, backend PDF generation, and browser-local history. It does not need
Firebase credentials for that workflow. Other pages still load Firebase and
external frontend assets; they are not fully offline.

Flask serves the `frontend/` directory as static files. In the Firebase-hosted
frontend, the Soil Test page's `soilai-api-base-url` meta tag points to the
Render API at `https://soilai.onrender.com`. For a local Flask-hosted workflow,
the same-origin API URL can be used by leaving this value empty.

### Local Engineering API

- `GET /api/health` — basic process health.
- `POST /api/calculate` — validate 4–10 trials and return trial calculations,
  quadratic fit, OMC/MDD, ZAV curve, and deterministic recommendations.
- `POST /api/predict` — estimate OMC/MDD from liquid and plastic limits and
  return a USCS/rules-based screening verdict.
- `POST /api/export-pdf` — generate a PDF from a calculated test payload.
- `GET /api/sample-data` — return legacy example trial data.
- `GET /api/system-info` — report local application components.

Example calculation request:

```json
{
  "test_name": "Field Sample A",
  "soil_type": "Sandy Silt (SM)",
  "trials": [
    {"container_no":"C-1","W1":25,"W2":187,"W3":175,"wet_density":1.86},
    {"container_no":"C-2","W1":25,"W2":191.5,"W3":175,"wet_density":1.98},
    {"container_no":"C-3","W1":25,"W2":196,"W3":175,"wet_density":2.08},
    {"container_no":"C-4","W1":25,"W2":200.5,"W3":175,"wet_density":2.06}
  ],
  "specific_gravity": 2.65
}
```

Example prediction request:

```json
{"liquid_limit": 60, "plastic_limit": 25}
```

The prediction pipeline is deterministic and runs locally, but its training
records are synthetic and generated from predefined empirical-style equations.
Reported holdout scores describe performance on a synthetic split only; they
are not calibrated confidence, laboratory validation, or evidence of
real-world accuracy. Treat predictions and rule-based recommendations as
screening information, not certified engineering advice.

### Known limitations and validation status

- No provenance-backed laboratory dataset is included. Real-world model
  evaluation remains future work and requires documented source, licensing,
  representative soil coverage, and independent validation.
- Backend tests include ReportLab PDF output tests. There is not yet a browser
  interaction test suite.
- Firestore rules are checked into source but have not been exercised against
  the Firebase Emulator Suite or deployed to the live project.
- The backend API does not currently have a configured Firebase Hosting rewrite
  or deployed service URL; those values depend on the target deployment.
- The application still uses external Firebase and CDN assets on cloud-backed
  pages, so the whole site is not offline-capable.

### Firebase Hosting and Render API

`firebase.json` currently serves the static `frontend/` directory and does not
contain an API rewrite. The API is deployed separately on Render. The frontend
uses the API base URL configured in `frontend/soil-test.html`. Set the Render
service environment variable `SOILAI_CORS_ORIGINS` to the exact Firebase
Hosting origin:

```text
https://soilai-691b5.web.app
```

Do not use `*`. Redeploy/restart the Render service after changing its
environment variable, then verify that API responses include
`Access-Control-Allow-Origin: https://soilai-691b5.web.app` before deploying
the frontend.

The Flask development server must not be exposed publicly. Use the container
configuration below for a production WSGI server. Render uses the Dockerfile's
Gunicorn command and supplies the `PORT` environment variable.

### Docker / Render

Build from the repository root:

```bash
docker build -t soilai-backend .
```

Run locally:

```bash
docker run --rm -p 8080:8080 soilai-backend
```

Then verify `http://127.0.0.1:8080/api/health` (for example,
`curl.exe http://127.0.0.1:8080/api/health` on Windows). The container uses
Gunicorn, binds to the injected `PORT` (8080 by default), and runs as a
non-root user. Configure `SOILAI_CORS_ORIGINS` on Render to the exact Firebase
Hosting origin. Docker build/start has not been verified in this environment
because the Docker daemon is unavailable; run these commands with Docker
Desktop/the daemon running.

Run backend tests and lint checks with:

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests -q
.\.venv\Scripts\ruff.exe check --select E4,E7,E9,F backend
```

On macOS/Linux, replace the Windows executable paths with
`./.venv/bin/python` and `./.venv/bin/ruff`. PDF tests require ReportLab and
are not intended to be skipped when development dependencies are installed.

---

## Firebase Configuration

The Firebase client configuration in `frontend/js/firebase-config.js` points
to the project's Firebase application:

```
Project ID:   soilai-691b5
Auth Domain:  soilai-691b5.firebaseapp.com
```

**Firestore Security Rules** (set in Firebase Console):
The rules source is [firestore.rules](./firestore.rules), and `firebase.json`
references it. Review the policy and test it with the Firebase Emulator Suite
before deploying. After testing and reviewing the active Firebase project,
deploy rules explicitly with `firebase deploy --only firestore:rules`. No live rules deployment was performed as part of this work,
and the rules have not yet been checked by the Emulator Suite. The current
frontend has no activity-log write path, so the rules permit owner-scoped
activity reads/deletes but deny activity creation/updates until a writer and
document schema are defined. The policy grants access only to authenticated
owners and constrains fields for the observed user, soil-test, and
moisture-test writes. The Firebase client API key is public client
configuration, not a service-account credential; restrict it using
Firebase/Google Cloud API settings and rely on Authentication plus Firestore
rules for data access.

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET  | `/api/health` | Basic server health |
| POST | `/api/calculate` | Validated Proctor calculation and fit |
| POST | `/api/predict` | Local synthetic-data model screening |
| POST | `/api/export-pdf` | Backend PDF report generation |
| GET  | `/api/sample-data` | Legacy demo data |
| GET  | `/api/system-info` | Application component information |

---

## Distributed Computing Concepts Demonstrated

1. **Firebase Firestore** — Cloud NoSQL storage for authenticated user records.
2. **Firestore `onSnapshot`** — Real-time listeners for dashboard and history updates.
3. **Firebase Authentication** — User sign-in for cloud-backed application pages.
4. **Local API** — Flask API for calculation, screening, and PDF workflows.
5. **Container deployment** — Docker image configured for a WSGI server; actual cloud deployment requires service-specific settings.

---

## Technology Stack

- **Frontend**: HTML5, CSS3 (Glassmorphism), Vanilla JS ES Modules
- **Backend**: Python 3.10+, Flask, Flask-CORS
- **Database**: Firebase Firestore (Google Cloud NoSQL)
- **Auth**: Firebase Authentication (OAuth2 / JWT)
- **Charts**: Chart.js 4.x
- **PDF**: ReportLab for the local Soil Test API; jsPDF on legacy report pages
- **Fonts**: Inter, JetBrains Mono (Google Fonts)
