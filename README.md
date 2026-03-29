# Warehouse AMR Dashboard

A **FastAPI v3 backend** with **WebSocket real-time** support and an interactive HTML dashboard for tracking Autonomous Mobile Robot (AMR) operations, inventory, and QR code scans.

**New in v3**: WebSocket endpoint (`/ws`), enriched scan records with product & inventory joins, and instant dashboard updates.

---

## Project Structure

```
Warehouse/
├── server.py           ← FastAPI backend (v3 with WebSocket)
├── index.html          ← Modern dashboard UI (7 tabs)
├── MJPEG stream on PC.py
└── README.md
```

**Dashboard Tabs**:

- **Live View** — Real-time scan spotlight + history feed
- **Robots** — CRUD for robot inventory
- **Locations** — CRUD for warehouse racks & slots
- **Products** — CRUD for product catalog
- **Inventory** — Track product quantities by location
- **Scan Logs** — View & manage all scans
- **Camera** — MJPEG stream viewer
- **AMR Control** — Robot teleoperation & navigation (ROS integration ready)

---

## Prerequisites

| Requirement                   | Notes                                                       |
| ----------------------------- | ----------------------------------------------------------- |
| Python 3.10+                  | —                                                           |
| SQL Server (Express or full)  | Running locally or on your network                          |
| ODBC Driver 17 for SQL Server | https://aka.ms/downloadmsodbcsql                            |
| WarehouseDB database          | Must exist before starting the server (auto-creates tables) |
| (Optional) Flask/MJPEG server | For MJPEG camera streaming                                  |
| (Optional) ROS 2 / Nav2       | For AMR control features (advanced)                         |

## Database Schema

The server auto-creates these tables on startup:

```sql
-- Robots: AMR fleet registry
CREATE TABLE Robots (
    id INT IDENTITY(1,1) PRIMARY KEY,
    robot_code NVARCHAR(50) NOT NULL,
    description NVARCHAR(100)
);

-- Locations: Warehouse racks & storage slots
CREATE TABLE Locations (
    id INT IDENTITY(1,1) PRIMARY KEY,
    location_code NVARCHAR(50) NOT NULL,
    rack NVARCHAR(50),
    slot NVARCHAR(50)
);

-- Products: SKU & product catalog
CREATE TABLE Products (
    id INT IDENTITY(1,1) PRIMARY KEY,
    product_code NVARCHAR(50) NOT NULL,
    name NVARCHAR(100),
    category NVARCHAR(100)
);

-- Inventory: Stock quantities
CREATE TABLE Inventory (
    id INT IDENTITY(1,1) PRIMARY KEY,
    product_id INT,
    location_id INT,
    quantity INT
);

-- ScanLogs: QR scan events
CREATE TABLE ScanLogs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    robot_code NVARCHAR(50),
    qr_code NVARCHAR(50),
    scan_time DATETIME DEFAULT GETDATE()
);
```

---

## Setup & Configuration

### 1. Install Python Dependencies

```bash
pip install fastapi uvicorn pyodbc python-multipart
```

---

### 2. Create the Database

Open **SQL Server Management Studio** (or `sqlcmd`) and run:

```sql
CREATE DATABASE WarehouseDB;
```

> The server will auto-create all five tables on first startup.

---

### 3. Configure the Server

Edit [server.py](server.py), find `DB_CONFIG` near the top, and set your SQL Server name:

```python
DB_CONFIG = {
    "driver":   "ODBC Driver 17 for SQL Server",
    "server":   r"YOUR_PC_NAME\SQLEXPRESS",   # ← change this
    "database": "WarehouseDB",
    "trusted":  True,                          # Windows Authentication
}
```

**To find your SQL Server name**, run in PowerShell or cmd:

```bash
sqlcmd -S . -Q "SELECT @@SERVERNAME;"
```

Or in **SQL Server Management Studio**, look at the server name in the title bar or Object Explorer.

---

### 4. Run the Server

```bash
uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

When the server starts, it will:

1. Auto-create all 5 database tables if they don't exist
2. Print `[DB] Tables verified.` to confirm
3. Listen on port 8000

**Access the dashboard**:

- **UI Dashboard** → http://localhost:8000
- **FastAPI Docs** → http://localhost:8000/docs
- **WebSocket Endpoint** → ws://localhost:8000/ws (used by dashboard for real-time updates)

---

## API Endpoints

### Core CRUD Operations

All tables support standard REST operations:

```
GET    /{table}        — List all rows
POST   /{table}        — Create new row
PUT    /{table}/{id}   — Update row
DELETE /{table}/{id}   — Delete row
```

**Tables**: `robots`, `locations`, `products`, `inventory`, `scanlogs`

### Real-Time Scan Ingestion

**`POST /scan`** — Robot sends a QR scan

```bash
curl -X POST http://localhost:8000/scan \
  -H "Content-Type: application/json" \
  -d '{"robot_code":"AMR_01","qr_code":"RACK_A_01"}'
```

Response: `{"status": "ok"}`

**What happens**:

1. Inserts into `ScanLogs`
2. Fetches enriched join: ScanLog → Location → Inventory → Product
3. **Broadcasts to ALL connected WebSocket clients instantly**

### Scan History

**`GET /scanlogs`** — Retrieve recent scans (top 100)

```bash
curl http://localhost:8000/scanlogs
```

Response:

```json
[
  {
    "id": 1,
    "robot_code": "AMR_01",
    "qr_code": "RACK_A_01",
    "scan_time": "2026-03-27 12:34:56"
  }
]
```

### Health Check

**`GET /health`** — API liveness probe

```bash
curl http://localhost:8000/health
```

Response:

```json
{
  "status": "ok",
  "timestamp": "2026-03-27T12:00:00.000000",
  "ws_clients": 3
}
```

---

## WebSocket Real-Time Updates

The dashboard connects via `ws://localhost:8000/ws` and receives live scan events:

```javascript
// Example: browser WebSocket client
const ws = new WebSocket("ws://localhost:8000/ws");

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === "history") {
    // On connect: receive last 20 scans
    console.log("History:", msg.data);
  } else if (msg.type === "scan") {
    // Real-time: new scan was recorded
    console.log("New scan:", msg.data);
  }
};
```

---

## Robot Integration (Raspberry Pi / Python)

On the robot, install `requests`:

```bash
pip install requests
```

After decoding a QR code with OpenCV, send a scan event:

```python
import requests
import json

SERVER_IP = "192.168.1.100"   # IP of the machine running uvicorn
PORT = 8000
ROBOT_CODE = "AMR_01"

def send_scan(qr_code):
    """Send QR scan to the Warehouse server."""
    try:
        response = requests.post(
            f"http://{SERVER_IP}:{PORT}/scan",
            json={"robot_code": ROBOT_CODE, "qr_code": qr_code},
            timeout=5,
        )
        data = response.json()
        print(f"✓ Scan sent: {qr_code} → {data['status']}")
        return True
    except Exception as e:
        print(f"✗ Scan failed: {e}")
        return False

# Example: after finding QR code with OpenCV
qr_result = "RACK_A_01"
send_scan(qr_result)
```

---

## Dashboard Features

| Tab             | Purpose                                                     |
| --------------- | ----------------------------------------------------------- |
| **Live View**   | Real-time scan spotlight + history feed                     |
| **Robots**      | List, add, edit, delete robot records                       |
| **Locations**   | Manage warehouse racks & slots                              |
| **Products**    | Product catalog (SKU, name, category)                       |
| **Inventory**   | Track stock by product & location (with joins)              |
| **Scan Logs**   | View all QR scan events with timestamps                     |
| **Camera**      | Live MJPEG stream viewer (configure camera URL in UI)       |
| **AMR Control** | Teleoperation, waypoint navigation, IMU display (ROS ready) |

**Key Features**:

- ✨ **WebSocket real-time updates** — No polling, instant dashboard refresh
- 📊 **Enriched scan data** — Each scan includes location, product, and inventory details
- 🔄 **Full CRUD** — Manage all entities through the web UI
- 📈 **Stats panel** — Displays summary metrics
- 📹 **Camera integration** — MJPEG stream support (configure URL in Settings)
- 🤖 **ROS-ready** — AMR control tab prepared for Navigation2 integration

---

## Common Tasks

### Add a New Robot

**Via API**:

```bash
curl -X POST http://localhost:8000/robots \
  -H "Content-Type: application/json" \
  -d '{"robot_code":"AMR_02","description":"Secondary carrier"}'
```

**Via Dashboard**: Click the **Robots** tab → **Add** button

### Register Warehouse Locations

**Via SQL** (optional, for initial setup):

```sql
INSERT INTO Locations (location_code, rack, slot)
VALUES ('RACK_A_01', 'A', '01'),
       ('RACK_A_02', 'A', '02'),
       ('RACK_B_01', 'B', '01');
```

**Via Dashboard**: **Locations** tab → **Add** button

### Add Products to Inventory

1. **Create product** in **Products** tab
2. **Create inventory record** linking product + location + quantity in **Inventory** tab
3. When robot scans, dashboard will display enriched data: robot → location → product → quantity

---

## Troubleshooting

| Issue                            | Solution                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `DB connection failed`           | Check `DB_CONFIG` server name matches `SELECT @@SERVERNAME;`                           |
| `[WinError 10048]` (port in use) | Change `--port 8000` to an available port                                              |
| WebSocket not connecting         | Ensure dashboard URL matches server IP/port (check browser console)                    |
| Tables missing after startup     | Check `[DB] Tables verified.` message in terminal; run ` init_db()` manually if needed |
| MJPEG camera not loading         | Verify camera server is running and URL is correct in dashboard                        |

---

## Architecture

```
┌─────────────────────┐
│  Browser Dashboard  │  (HTML/CSS/JS)
│   (8 tabs)          │
└──────────┬──────────┘
           │ HTTP / WebSocket
           ▼
┌─────────────────────┐
│  FastAPI Server     │  (Python)
│  (server.py)        │  • CORS enabled
└──────────┬──────────┘  • Auto-init DB
           │ pyodbc
           ▼
┌─────────────────────┐
│  SQL Server         │  (5 tables)
│  WarehouseDB        │  • Robots
└─────────────────────┘  • Locations
                          • Products
                          • Inventory
                          • ScanLogs
```

---

## Next Steps & Future Development

- [ ] **Pagination** — Add limit/offset to list endpoints
- [ ] **Aggregation** — `/stats` endpoint for analytics
- [ ] **Authentication** — API key or JWT before exposing to network
- [ ] **Dashboard Preferences** — Persist filters and view settings per user
- [ ] **ROS 2 Integration** — Full Navigation2 package integration for autonomous navigation
- [ ] **Performance** — Index ScanLogs table on `scan_time` and `robot_code`
- [ ] **Export** — CSV/Excel reports of scan history and inventory
- [ ] **Alerts** — Notify on low stock, robot offline, location empty

---

## License

[Add your license here, e.g., MIT, Apache 2.0]

---

## Support

For issues or questions, check the [FastAPI documentation](https://fastapi.tiangolo.com/) or SQL Server ODBC [driver docs](https://learn.microsoft.com/en-us/sql/connect/odbc/microsoft-odbc-driver-for-sql-server).
