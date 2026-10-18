# SoilAI Cloud Lab 🧪

**Professional Geotechnical Engineering Analytics Platform**  
*Cloud Computing & Distributed Computing Systems Demo*

---

## Overview

SoilAI Cloud Lab is a full-stack web application for soil compaction analysis using:
- **Flask** (Python) REST API backend
- **Firebase Authentication** (login / signup / password reset)
- **Firebase Firestore** real-time distributed database
- **Chart.js** interactive compaction curves
- **jsPDF** professional PDF report generation
- Dark glassmorphism engineering UI

---

## Features

| Feature | Description |
|---|---|
| 🔐 Auth | Firebase login, signup, forgot password |
| 🧪 Soil Test | Dynamic trial input, live MC/DD preview |
| ⚡ Calculations | MC, Dry Density, OMC, MDD via Flask API |
| 📊 Charts | Moisture Content vs Dry Density curve with OMC/MDD highlight |
| ☁️ Cloud Sync | Firestore real-time sync across all users/devices |
| 💡 AI Recommendations | Rule-based compaction advice |
| 📄 PDF Reports | Full engineering reports with jsPDF |

---

## Formulas

```
Moisture Content (%) = ((W2 - W3) / (W3 - W1)) × 100

Dry Density (g/cm³)  = Wet Density / (1 + MC / 100)

OMC  = Moisture Content at Maximum Dry Density
MDD  = Maximum value of Dry Density across all trials
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
│   └── requirements.txt    # Python dependencies
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
└── README.md
```

---

## Setup & Running

### 1. Install Python Dependencies

```bash
python -m pip install -r backend/requirements.txt
```

### 2. Run the Flask Server

```bash
python backend/app.py
```

The server starts at **http://127.0.0.1:5000** by default. Set `SOILAI_HOST`,
`SOILAI_PORT` (or `PORT`) and `SOILAI_DEBUG=true` only when you explicitly need
to override the safe local defaults.

### 3. Open the App

Visit **http://127.0.0.1:5000/soil-test** for the local recruiter demo.
The Soil Test page uses the local Flask API, local PDF generation, and
browser-local history; it does not require Firebase credentials or external
AI services. The login, cloud dashboard, reports, and sync features elsewhere
in the app still use the existing Firebase configuration.

Flask serves the entire `frontend/` directory as static files.

### Local Engineering API

- `POST /api/calculate` — validate and calculate 4–10 compaction trials,
  quadratic fit, ZAV curve, and deterministic equipment/suitability rules.
- `POST /api/predict` — return a local empirical OMC/MDD screening estimate
  from liquid and plastic limits; this is not a laboratory result.
- `POST /api/export-pdf` — generate an ASTM D698 / IS 2720-stamped PDF locally.

Run the backend regression suite with:

```bash
python -m pytest backend/tests
```

---

## Firebase Configuration

The Firebase project is pre-configured in `frontend/js/firebase-config.js`:

```
Project ID:   soilai-691b5
Auth Domain:  soilai-691b5.firebaseapp.com
```

**Firestore Security Rules** (set in Firebase Console):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /soilTests/{docId} {
      allow read, delete: if request.auth != null && request.auth.uid == resource.data.uid;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.uid;
      allow update: if request.auth != null
        && request.auth.uid == resource.data.uid
        && request.auth.uid == request.resource.data.uid;
    }
    match /activityLog/{docId} {
      allow read, delete: if request.auth != null && request.auth.uid == resource.data.uid;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.uid;
      allow update: if request.auth != null
        && request.auth.uid == resource.data.uid
        && request.auth.uid == request.resource.data.uid;
    }
    match /moistureTests/{docId} {
      allow read, delete: if request.auth != null && request.auth.uid == resource.data.uid;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.uid;
      allow update: if request.auth != null
        && request.auth.uid == resource.data.uid
        && request.auth.uid == request.resource.data.uid;
    }
  }
}
```

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET  | `/api/health` | Server health & distributed system info |
| POST | `/api/calculate` | Full test calculation (OMC, MDD, all trials) |
| POST | `/api/calculate/single-trial` | Live preview for one trial |
| POST | `/api/recommendations` | Get compaction recommendations |
| GET  | `/api/sample-data` | Load demo data |
| GET  | `/api/system-info` | Cloud architecture info |

---

## Distributed Computing Concepts Demonstrated

1. **Firebase Firestore** — NoSQL distributed cloud database with automatic multi-region replication
2. **Firestore `onSnapshot`** — Real-time push sync: all connected clients see updates instantly
3. **Firebase Authentication** — Federated identity management with JWT tokens
4. **Multi-user concurrent access** — Multiple engineers can run tests simultaneously
5. **Offline resilience** — Firestore SDK caches data locally when offline
6. **Cloud-deployable API** — Flask backend can be deployed to GCP, AWS, or Azure

---

## Technology Stack

- **Frontend**: HTML5, CSS3 (Glassmorphism), Vanilla JS ES Modules
- **Backend**: Python 3.10+, Flask, Flask-CORS
- **Database**: Firebase Firestore (Google Cloud NoSQL)
- **Auth**: Firebase Authentication (OAuth2 / JWT)
- **Charts**: Chart.js 4.x
- **PDF**: jsPDF 2.x
- **Fonts**: Inter, JetBrains Mono (Google Fonts)
