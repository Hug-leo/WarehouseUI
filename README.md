# Warehouse AMR Dashboard

A FastAPI + SQL Server backend with a real-time HTML dashboard for tracking Autonomous Mobile Robot (AMR) QR scans.

---

## Project Structure

```
warehouse_server/
├── server.py      ← FastAPI backend (all logic lives here)
└── index.html     ← Dashboard UI (auto-refreshes every 3 s)
```

---

## Prerequisites

| Requirement                     | Notes                                              |
|---------------------------------|----------------------------------------------------|
| Python 3.10+                    | —                                                  |
| SQL Server (Express or full)    | Running locally or on your network                 |
| ODBC Driver 17 for SQL Server   | https://aka.ms/downloadmsodbcsql                   |
| WarehouseDB database            | Must exist before starting the server              |

---

## 1 — Install Python dependencies

```bash
pip install fastapi uvicorn pyodbc
```

---

## 2 — Create the database

Open **SQL Server Management Studio** (or `sqlcmd`) and run:

```sql
CREATE DATABASE WarehouseDB;
```

> The server will auto-create **Locations** and **ScanLogs** tables on first startup.

---

## 3 — Configure the server

Edit **`server.py`**, find `DB_CONFIG` near the top, and set your server name:

```python
DB_CONFIG = {
    "driver":   "ODBC Driver 17 for SQL Server",
    "server":   r"YOUR_PC_NAME\SQLEXPRESS",   # ← change this
    "database": "WarehouseDB",
    "trusted":  True,                          # Windows Authentication
}
```

To find your server name:

```sql
-- Run this in SSMS
SELECT @@SERVERNAME;
```

---

## 4 — Run the server

```bash
cd warehouse_server
uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

- Dashboard → http://localhost:8000
- API docs  → http://localhost:8000/docs

---

## 5 — API Reference

### `POST /scan`
Robot sends a QR scan event.

```bash
curl -X POST http://localhost:8000/scan \
  -H "Content-Type: application/json" \
  -d '{"robot_code":"AMR_01","qr_code":"RACK_A_01"}'
```

Response:
```json
{ "status": "ok" }
```

---

### `GET /logs`
Returns the 50 most recent scan entries (newest first).

```bash
curl http://localhost:8000/logs
```

Response:
```json
[
  { "id": 3, "robot": "AMR_01", "qr": "RACK_A_01", "time": "2026-03-11 21:00:00" },
  ...
]
```

---

### `GET /health`
Quick liveness probe (does not touch the DB).

```bash
curl http://localhost:8000/health
```

---

## 6 — Dashboard features

| Feature                  | Detail                                         |
|--------------------------|------------------------------------------------|
| Auto-refresh             | Polls `/logs` every **3 seconds**              |
| New-row highlight        | Rows that didn't exist on the last fetch flash amber |
| Stats bar                | Shows total logs, active robots, unique locations, last scan |
| API status               | ONLINE (green) / OFFLINE (red)                 |
| Manual scan injection    | Bottom panel — POST a scan directly from the browser |

---

## 7 — Raspberry Pi robot integration

On the robot, install `requests`:

```bash
pip install requests
```

After decoding a QR code with OpenCV:

```python
import requests

SERVER_IP = "192.168.x.x"   # IP of the machine running uvicorn
QR_STRING = "RACK_A_01"     # decoded from camera

response = requests.post(
    f"http://{SERVER_IP}:8000/scan",
    json={"robot_code": "AMR_01", "qr_code": QR_STRING},
    timeout=5,
)
print(response.json())   # {"status": "ok"}
```

---

## 8 — Adding more robots or rack locations

**Register rack locations** (optional — for future FK lookups):

```sql
INSERT INTO Locations (location_code, rack, slot)
VALUES ('RACK_A_01', 'A', '01'),
       ('RACK_A_02', 'A', '02'),
       ('RACK_B_01', 'B', '01');
```

**Add a second robot** — just change `robot_code` in the POST body. No schema changes needed.

---

## 9 — Next development steps

- [ ] Add pagination to `/logs` (skip / limit query params)
- [ ] Add `/stats` endpoint aggregating by robot and rack
- [ ] Add authentication (API key header) before exposing to the network
- [ ] Persist dashboard preferences (robot filter, time range)
- [ ] Add WebSocket push so the dashboard reacts instantly instead of polling
