"""
Warehouse AMR Dashboard — FastAPI Backend v3
============================================
NEW in v3:
  - WebSocket endpoint /ws
  - POST /scan now fetches the full joined record (Robot + Location + Product + Qty)
    and broadcasts it to ALL connected dashboard clients instantly.

Tables:   Robots · Locations · Products · Inventory · ScanLogs
CRUD:
  GET    /<table>        — list rows
  POST   /<table>        — create row
  PUT    /<table>/{id}   — update row
  DELETE /<table>/{id}   — delete row

Real-time:
  POST   /scan           — robot scan  →  saves + broadcasts via WebSocket
  WS     /ws             — dashboard connects here to receive live pushes

Utility:
  GET    /health
  GET    /               — serves index.html

Run:
  uvicorn server:app --reload --host 0.0.0.0 --port 8000
"""

import os
import json
import pyodbc
from datetime import datetime
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# ← EDIT: your SQL Server name
# ─────────────────────────────────────────────────────────────────────────────
DB_CONFIG = {
    "driver": "ODBC Driver 17 for SQL Server",
    "server": r"LAPTOP-6CG6MGNS\SQLEXPRESS",
    "database": "WarehouseDB",
    "trusted": True,
}

# ─────────────────────────────────────────────────────────────────────────────
# DB helpers
# ─────────────────────────────────────────────────────────────────────────────


def get_connection() -> pyodbc.Connection:
    conn_str = (
        f"DRIVER={{{DB_CONFIG['driver']}}};"
        f"SERVER={DB_CONFIG['server']};"
        f"DATABASE={DB_CONFIG['database']};"
        f"Trusted_Connection={'yes' if DB_CONFIG['trusted'] else 'no'};"
    )
    try:
        return pyodbc.connect(conn_str)
    except pyodbc.Error as exc:
        raise HTTPException(status_code=503, detail=f"DB connection failed: {exc}")


def rows_to_list(cursor, rows) -> list[dict]:
    cols = [c[0] for c in cursor.description]
    return [dict(zip(cols, r)) for r in rows]


def init_db():
    stmts = [
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Robots')
           CREATE TABLE Robots (
               id INT IDENTITY(1,1) PRIMARY KEY,
               robot_code NVARCHAR(50) NOT NULL,
               description NVARCHAR(100)
           )""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Locations')
           CREATE TABLE Locations (
               id INT IDENTITY(1,1) PRIMARY KEY,
               location_code NVARCHAR(50) NOT NULL,
               rack NVARCHAR(50),
               slot NVARCHAR(50)
           )""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Products')
           CREATE TABLE Products (
               id INT IDENTITY(1,1) PRIMARY KEY,
               product_code NVARCHAR(50) NOT NULL,
               name NVARCHAR(100),
               category NVARCHAR(100)
           )""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Inventory')
           CREATE TABLE Inventory (
               id INT IDENTITY(1,1) PRIMARY KEY,
               product_id INT,
               location_id INT,
               quantity INT
           )""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ScanLogs')
           CREATE TABLE ScanLogs (
               id INT IDENTITY(1,1) PRIMARY KEY,
               robot_code NVARCHAR(50),
               qr_code NVARCHAR(50),
               scan_time DATETIME DEFAULT GETDATE()
           )""",
    ]
    with get_connection() as conn:
        cur = conn.cursor()
        for s in stmts:
            cur.execute(s)
        conn.commit()
    print("[DB] Tables verified.")


def fetch_enriched_scan(scan_id: int) -> dict:
    """
    Given a ScanLog id, return a fully joined record:
      robot_code, qr_code, scan_time,
      location → rack, slot,
      product  → product_code, name, category,
      inventory → quantity
    """
    sql = """
        SELECT
            s.id,
            s.robot_code,
            s.qr_code,
            CONVERT(NVARCHAR, s.scan_time, 120)  AS scan_time,
            l.rack,
            l.slot,
            p.product_code,
            p.name         AS product_name,
            p.category,
            i.quantity
        FROM ScanLogs s
        LEFT JOIN Locations l ON  s.qr_code = l.location_code
        LEFT JOIN Inventory  i ON l.id       = i.location_id
        LEFT JOIN Products   p ON i.product_id = p.id
        WHERE s.id = ?
    """
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(sql, scan_id)
        row = cur.fetchone()
        if not row:
            return {}
        cols = [c[0] for c in cur.description]
        return dict(zip(cols, row))


def fetch_recent_enriched(limit: int = 20) -> list[dict]:
    """Return the last N scans, fully joined."""
    sql = """
        SELECT TOP (?)
            s.id,
            s.robot_code,
            s.qr_code,
            CONVERT(NVARCHAR, s.scan_time, 120)  AS scan_time,
            l.rack,
            l.slot,
            p.product_code,
            p.name         AS product_name,
            p.category,
            i.quantity
        FROM ScanLogs s
        LEFT JOIN Locations l ON  s.qr_code   = l.location_code
        LEFT JOIN Inventory  i ON l.id         = i.location_id
        LEFT JOIN Products   p ON i.product_id = p.id
        ORDER BY s.scan_time DESC
    """
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(sql, limit)
        return rows_to_list(cur, cur.fetchall())


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket connection manager
# ─────────────────────────────────────────────────────────────────────────────


class ConnectionManager:
    """Keeps track of all live dashboard WebSocket connections."""

    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)
        print(f"[WS] Client connected  — total: {len(self.active)}")

    def disconnect(self, ws: WebSocket):
        self.active.remove(ws)
        print(f"[WS] Client disconnected — total: {len(self.active)}")

    async def broadcast(self, data: dict):
        """Push a JSON message to every connected dashboard client."""
        payload = json.dumps(data, default=str)
        dead = []
        for ws in self.active:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active.remove(ws)


manager = ConnectionManager()


# ─────────────────────────────────────────────────────────────────────────────
# App
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="Warehouse AMR API", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    try:
        init_db()
    except HTTPException as e:
        print(f"[WARN] DB init skipped: {e.detail}")


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket endpoint
# ─────────────────────────────────────────────────────────────────────────────


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """
    Dashboard connects here.
    On connect, immediately send the last 20 enriched scans so the UI
    is populated without waiting for the first robot scan.
    """
    await manager.connect(ws)
    try:
        # Send initial history on connect
        try:
            history = fetch_recent_enriched(20)
            await ws.send_text(
                json.dumps({"type": "history", "data": history}, default=str)
            )
        except Exception as e:
            await ws.send_text(json.dumps({"type": "error", "message": str(e)}))

        # Keep connection alive — client can send pings if desired
        while True:
            await ws.receive_text()

    except WebSocketDisconnect:
        manager.disconnect(ws)


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────────────────────────────────────


class ScanRequest(BaseModel):
    robot_code: str
    qr_code: str


class RobotCreate(BaseModel):
    robot_code: str
    description: Optional[str] = None


class RobotUpdate(BaseModel):
    robot_code: Optional[str] = None
    description: Optional[str] = None


class LocationCreate(BaseModel):
    location_code: str
    rack: Optional[str] = None
    slot: Optional[str] = None


class LocationUpdate(BaseModel):
    location_code: Optional[str] = None
    rack: Optional[str] = None
    slot: Optional[str] = None


class ProductCreate(BaseModel):
    product_code: str
    name: Optional[str] = None
    category: Optional[str] = None


class ProductUpdate(BaseModel):
    product_code: Optional[str] = None
    name: Optional[str] = None
    category: Optional[str] = None


class InventoryCreate(BaseModel):
    product_id: int
    location_id: int
    quantity: int


class InventoryUpdate(BaseModel):
    product_id: Optional[int] = None
    location_id: Optional[int] = None
    quantity: Optional[int] = None


class ScanCreate(BaseModel):
    robot_code: str
    qr_code: str


# ─────────────────────────────────────────────────────────────────────────────
# SCAN  ← main robot endpoint — saves + broadcasts
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/scan", tags=["ScanLogs"])
async def post_scan(b: ScanRequest):
    """
    Called by the Raspberry Pi robot.
    1. Inserts into ScanLogs
    2. Fetches the enriched joined record
    3. Broadcasts to ALL connected WebSocket clients immediately
    """
    # 1. Insert
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO ScanLogs (robot_code, qr_code, scan_time) VALUES (?,?,GETDATE())",
            b.robot_code,
            b.qr_code,
        )
        cur.execute("SELECT SCOPE_IDENTITY()")
        new_id = int(cur.fetchone()[0])
        conn.commit()

    # 2. Fetch enriched
    enriched = fetch_enriched_scan(new_id)

    # 3. Broadcast to dashboard clients
    await manager.broadcast({"type": "scan", "data": enriched})

    return {"status": "ok"}


# ─────────────────────────────────────────────────────────────────────────────
# ROBOTS CRUD
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/robots", tags=["Robots"])
def get_robots():
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM Robots ORDER BY id DESC")
        return rows_to_list(cur, cur.fetchall())


@app.post("/robots", tags=["Robots"], status_code=201)
def create_robot(b: RobotCreate):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO Robots (robot_code, description) VALUES (?,?)",
            b.robot_code,
            b.description,
        )
        conn.commit()
    return {"status": "created"}


@app.put("/robots/{rid}", tags=["Robots"])
def update_robot(rid: int, b: RobotUpdate):
    f, v = [], []
    if b.robot_code is not None:
        f.append("robot_code=?")
        v.append(b.robot_code)
    if b.description is not None:
        f.append("description=?")
        v.append(b.description)
    if not f:
        raise HTTPException(400, "No fields")
    v.append(rid)
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE Robots SET {','.join(f)} WHERE id=?", *v)
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        conn.commit()
    return {"status": "updated"}


@app.delete("/robots/{rid}", tags=["Robots"])
def delete_robot(rid: int):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM Robots WHERE id=?", rid)
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        conn.commit()
    return {"status": "deleted"}


# ─────────────────────────────────────────────────────────────────────────────
# LOCATIONS CRUD
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/locations", tags=["Locations"])
def get_locations():
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM Locations ORDER BY id DESC")
        return rows_to_list(cur, cur.fetchall())


@app.post("/locations", tags=["Locations"], status_code=201)
def create_location(b: LocationCreate):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO Locations (location_code, rack, slot) VALUES (?,?,?)",
            b.location_code,
            b.rack,
            b.slot,
        )
        conn.commit()
    return {"status": "created"}


@app.put("/locations/{lid}", tags=["Locations"])
def update_location(lid: int, b: LocationUpdate):
    f, v = [], []
    if b.location_code is not None:
        f.append("location_code=?")
        v.append(b.location_code)
    if b.rack is not None:
        f.append("rack=?")
        v.append(b.rack)
    if b.slot is not None:
        f.append("slot=?")
        v.append(b.slot)
    if not f:
        raise HTTPException(400, "No fields")
    v.append(lid)
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE Locations SET {','.join(f)} WHERE id=?", *v)
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        conn.commit()
    return {"status": "updated"}


@app.delete("/locations/{lid}", tags=["Locations"])
def delete_location(lid: int):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM Locations WHERE id=?", lid)
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        conn.commit()
    return {"status": "deleted"}


# ─────────────────────────────────────────────────────────────────────────────
# PRODUCTS CRUD
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/products", tags=["Products"])
def get_products():
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM Products ORDER BY id DESC")
        return rows_to_list(cur, cur.fetchall())


@app.post("/products", tags=["Products"], status_code=201)
def create_product(b: ProductCreate):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO Products (product_code, name, category) VALUES (?,?,?)",
            b.product_code,
            b.name,
            b.category,
        )
        conn.commit()
    return {"status": "created"}


@app.put("/products/{pid}", tags=["Products"])
def update_product(pid: int, b: ProductUpdate):
    f, v = [], []
    if b.product_code is not None:
        f.append("product_code=?")
        v.append(b.product_code)
    if b.name is not None:
        f.append("name=?")
        v.append(b.name)
    if b.category is not None:
        f.append("category=?")
        v.append(b.category)
    if not f:
        raise HTTPException(400, "No fields")
    v.append(pid)
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE Products SET {','.join(f)} WHERE id=?", *v)
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        conn.commit()
    return {"status": "updated"}


@app.delete("/products/{pid}", tags=["Products"])
def delete_product(pid: int):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM Products WHERE id=?", pid)
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        conn.commit()
    return {"status": "deleted"}


# ─────────────────────────────────────────────────────────────────────────────
# INVENTORY CRUD
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/inventory", tags=["Inventory"])
def get_inventory():
    sql = """
        SELECT i.id, i.product_id, i.location_id, i.quantity,
               p.product_code, p.name AS product_name,
               l.location_code, l.rack, l.slot
        FROM   Inventory i
        LEFT JOIN Products  p ON i.product_id  = p.id
        LEFT JOIN Locations l ON i.location_id = l.id
        ORDER BY i.id DESC
    """
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(sql)
        return rows_to_list(cur, cur.fetchall())


@app.post("/inventory", tags=["Inventory"], status_code=201)
def create_inventory(b: InventoryCreate):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO Inventory (product_id, location_id, quantity) VALUES (?,?,?)",
            b.product_id,
            b.location_id,
            b.quantity,
        )
        conn.commit()
    return {"status": "created"}


@app.put("/inventory/{iid}", tags=["Inventory"])
def update_inventory(iid: int, b: InventoryUpdate):
    f, v = [], []
    if b.product_id is not None:
        f.append("product_id=?")
        v.append(b.product_id)
    if b.location_id is not None:
        f.append("location_id=?")
        v.append(b.location_id)
    if b.quantity is not None:
        f.append("quantity=?")
        v.append(b.quantity)
    if not f:
        raise HTTPException(400, "No fields")
    v.append(iid)
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE Inventory SET {','.join(f)} WHERE id=?", *v)
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        conn.commit()
    return {"status": "updated"}


@app.delete("/inventory/{iid}", tags=["Inventory"])
def delete_inventory(iid: int):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM Inventory WHERE id=?", iid)
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        conn.commit()
    return {"status": "deleted"}


# ─────────────────────────────────────────────────────────────────────────────
# SCANLOGS CRUD  (manual, separate from /scan)
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/scanlogs", tags=["ScanLogs"])
def get_scanlogs():
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT TOP 100 id, robot_code, qr_code,
                   CONVERT(NVARCHAR, scan_time, 120) AS scan_time
            FROM ScanLogs ORDER BY scan_time DESC
        """
        )
        return rows_to_list(cur, cur.fetchall())


@app.post("/scanlogs", tags=["ScanLogs"], status_code=201)
async def create_scanlog(b: ScanCreate):
    """Manual insert from dashboard — also broadcasts via WebSocket."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO ScanLogs (robot_code, qr_code, scan_time) VALUES (?,?,GETDATE())",
            b.robot_code,
            b.qr_code,
        )
        cur.execute("SELECT SCOPE_IDENTITY()")
        new_id = int(cur.fetchone()[0])
        conn.commit()
    enriched = fetch_enriched_scan(new_id)
    await manager.broadcast({"type": "scan", "data": enriched})
    return {"status": "created"}


@app.delete("/scanlogs/{lid}", tags=["ScanLogs"])
def delete_scanlog(lid: int):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM ScanLogs WHERE id=?", lid)
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        conn.commit()
    return {"status": "deleted"}


# ─────────────────────────────────────────────────────────────────────────────
# Utility
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/health", tags=["Utility"])
def health():
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
        "ws_clients": len(manager.active),
    }


@app.get("/", include_in_schema=False)
def serve_ui():
    path = os.path.join(os.path.dirname(__file__), "index.html")
    if not os.path.exists(path):
        raise HTTPException(404, "index.html not found")
    return FileResponse(path, media_type="text/html")
