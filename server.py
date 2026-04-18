"""
Warehouse AMR Dashboard — FastAPI Backend v5
============================================
NEW in v5:
  - Cloud Bridge: Pi agent connects outbound → server relays to dashboard
    No port forwarding or LAN required on the Pi side.
  - /ws/robot-agent/{code}  — Pi bridge agent connects here
  - /robot-agents           — list which robots have cloud agents online

v4 features (retained):
  - /ros-proxy   WebSocket proxy → Pi rosbridge (LAN) or cloud bridge (Internet)
  - /camera-proxy HTTP proxy     → relays Pi MJPEG stream (port 5000)
  - All browser traffic now goes through THIS server only (port 8000).

Tables:   Robots · Locations · Products · Inventory · ScanLogs
CRUD:
  GET    /<table>        — list rows
  POST   /<table>        — create row
  PUT    /<table>/{id}   — update row
  DELETE /<table>/{id}   — delete row

Real-time:
  POST   /scan           — robot scan  →  saves + broadcasts via WebSocket
  WS     /ws             — dashboard connects here to receive live pushes

Proxy:
  WS     /ros-proxy?robot=AMR_01   — proxies rosbridge WebSocket
  GET    /camera-proxy?robot=AMR_01 — proxies MJPEG camera stream

Utility:
  GET    /health
  GET    /               — serves index.html

Run:
  uvicorn server:app --reload --host 0.0.0.0 --port 8000
"""

import os
import json
import asyncio
import pyodbc
import httpx
import websockets
from datetime import datetime
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional, List
import math

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
               description NVARCHAR(100),
               status NVARCHAR(20) DEFAULT 'IDLE',
               ip_address NVARCHAR(50),
               home_x FLOAT DEFAULT -1.29553,
               home_y FLOAT DEFAULT -0.0492027,
               home_yaw FLOAT DEFAULT 0.1848
           )""",
        # Migrate existing Robots table — add new columns if missing
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Robots' AND COLUMN_NAME='status')
           ALTER TABLE Robots ADD status NVARCHAR(20) DEFAULT 'IDLE'""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Robots' AND COLUMN_NAME='ip_address')
           ALTER TABLE Robots ADD ip_address NVARCHAR(50)""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Robots' AND COLUMN_NAME='home_x')
           ALTER TABLE Robots ADD home_x FLOAT DEFAULT -1.29553""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Robots' AND COLUMN_NAME='home_y')
           ALTER TABLE Robots ADD home_y FLOAT DEFAULT -0.0492027""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Robots' AND COLUMN_NAME='home_yaw')
           ALTER TABLE Robots ADD home_yaw FLOAT DEFAULT 0.1848""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Locations')
           CREATE TABLE Locations (
               id INT IDENTITY(1,1) PRIMARY KEY,
               location_code NVARCHAR(50) NOT NULL,
               rack NVARCHAR(50),
                    slot NVARCHAR(50),
                    loc_x FLOAT,
                    loc_y FLOAT,
                    loc_yaw FLOAT
           )""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Locations' AND COLUMN_NAME='loc_x')
              ALTER TABLE Locations ADD loc_x FLOAT""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Locations' AND COLUMN_NAME='loc_y')
              ALTER TABLE Locations ADD loc_y FLOAT""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Locations' AND COLUMN_NAME='loc_yaw')
              ALTER TABLE Locations ADD loc_yaw FLOAT""",
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
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Orders')
           CREATE TABLE Orders (
               id INT IDENTITY(1,1) PRIMARY KEY,
               order_code NVARCHAR(50) NOT NULL,
               status NVARCHAR(20) DEFAULT 'PENDING',
               assigned_robot NVARCHAR(50),
               created_at DATETIME DEFAULT GETDATE(),
               completed_at DATETIME
           )""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='OrderItems')
           CREATE TABLE OrderItems (
               id INT IDENTITY(1,1) PRIMARY KEY,
               order_id INT NOT NULL,
               product_id INT NOT NULL,
               quantity INT NOT NULL,
               picked_qty INT DEFAULT 0,
               status NVARCHAR(20) DEFAULT 'PENDING'
           )""",
        """IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PickTasks')
           CREATE TABLE PickTasks (
               id INT IDENTITY(1,1) PRIMARY KEY,
               order_id INT NOT NULL,
               order_item_id INT NOT NULL,
               location_id INT NOT NULL,
               product_id INT NOT NULL,
               quantity INT NOT NULL,
               seq INT NOT NULL,
               status NVARCHAR(20) DEFAULT 'PENDING',
               nav_x FLOAT,
               nav_y FLOAT,
               nav_yaw FLOAT,
               scanned_at DATETIME,
               picked_at DATETIME
           )""",
    ]
    with get_connection() as conn:
        cur = conn.cursor()
        for s in stmts:
            cur.execute(s)
        conn.commit()
    print("[DB] Tables verified.")


# ─────────────────────────────────────────────────────────────────────────────
# Shelf coordinate map — matches dashboard PRESETS & physical rack positions
# key = location_code, value = {x, y, yaw} in the ROS map frame
# ─────────────────────────────────────────────────────────────────────────────
SHELF_COORDS = {
    "RACK_A_01": {"x": -0.546, "y": -0.512, "yaw": -1.57},
    "RACK_A_02": {"x": -0.546, "y": -0.512, "yaw": -1.57},
    "RACK_A_03": {"x": -0.546, "y": -0.512, "yaw": -1.57},
    "RACK_B_01": {"x": 0.997, "y": -0.417, "yaw": 0.0},
    "RACK_B_02": {"x": 0.997, "y": -0.417, "yaw": 0.0},
    "RACK_B_03": {"x": 0.997, "y": -0.417, "yaw": 0.0},
    "RACK_C_01": {"x": 1.010, "y": 0.557, "yaw": 1.57},
    "RACK_C_02": {"x": 1.010, "y": 0.557, "yaw": 1.57},
    "RACK_C_03": {"x": 1.010, "y": 0.557, "yaw": 1.57},
    "RACK_D_01": {"x": -0.534, "y": 0.278, "yaw": 3.14159},
    "RACK_D_02": {"x": -0.534, "y": 0.278, "yaw": 3.14159},
    "RACK_D_03": {"x": -0.534, "y": 0.278, "yaw": 3.14159},
}
HOME_COORD = {"x": -1.29553, "y": -0.0492027, "yaw": 0.1848}


def get_robot_home(robot_code: str) -> dict:
    """Look up a robot's home position by robot_code. Returns HOME_COORD as fallback."""
    if not robot_code:
        return HOME_COORD
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT home_x, home_y, home_yaw FROM Robots WHERE robot_code=?",
            robot_code,
        )
        row = cur.fetchone()
        if row and row[0] is not None:
            return {"x": row[0], "y": row[1], "yaw": row[2]}
    return HOME_COORD


def plan_pick_route(
    items_with_locations: list, robot_x: float = None, robot_y: float = None
) -> list:
    """
    Nearest-neighbor TSP: given a list of (order_item_id, product_id, qty, location_id, location_code),
    return them sorted by shortest travel path from current robot position.
    """
    if robot_x is None:
        robot_x, robot_y = HOME_COORD["x"], HOME_COORD["y"]

    remaining = list(items_with_locations)
    route = []
    cx, cy = robot_x, robot_y

    while remaining:
        best_idx, best_dist = 0, float("inf")
        for i, item in enumerate(remaining):
            coord = SHELF_COORDS.get(item["location_code"], HOME_COORD)
            d = math.sqrt((coord["x"] - cx) ** 2 + (coord["y"] - cy) ** 2)
            if d < best_dist:
                best_dist = d
                best_idx = i
        chosen = remaining.pop(best_idx)
        coord = SHELF_COORDS.get(chosen["location_code"], HOME_COORD)
        cx, cy = coord["x"], coord["y"]
        route.append(chosen)

    return route


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
    status: Optional[str] = "IDLE"
    ip_address: Optional[str] = None
    home_x: Optional[float] = None
    home_y: Optional[float] = None
    home_yaw: Optional[float] = None


class RobotUpdate(BaseModel):
    robot_code: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    ip_address: Optional[str] = None
    home_x: Optional[float] = None
    home_y: Optional[float] = None
    home_yaw: Optional[float] = None


class LocationCreate(BaseModel):
    location_code: str
    rack: Optional[str] = None
    slot: Optional[str] = None
    loc_x: Optional[float] = None
    loc_y: Optional[float] = None
    loc_yaw: Optional[float] = None


class LocationUpdate(BaseModel):
    location_code: Optional[str] = None
    rack: Optional[str] = None
    slot: Optional[str] = None
    loc_x: Optional[float] = None
    loc_y: Optional[float] = None
    loc_yaw: Optional[float] = None


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


class OrderCreate(BaseModel):
    order_code: str
    assigned_robot: Optional[str] = "AMR_01"
    items: List[dict]  # [{"product_id": 1, "quantity": 2}, ...]


class PickConfirm(BaseModel):
    qr_code: str
    robot_code: str


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
            "INSERT INTO ScanLogs (robot_code, qr_code, scan_time) OUTPUT INSERTED.id VALUES (?,?,GETDATE())",
            b.robot_code,
            b.qr_code,
        )
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
        hx = b.home_x if b.home_x is not None else HOME_COORD["x"]
        hy = b.home_y if b.home_y is not None else HOME_COORD["y"]
        hyaw = b.home_yaw if b.home_yaw is not None else HOME_COORD["yaw"]
        cur.execute(
            "INSERT INTO Robots (robot_code, description, status, ip_address, home_x, home_y, home_yaw) VALUES (?,?,?,?,?,?,?)",
            b.robot_code,
            b.description,
            b.status or "IDLE",
            b.ip_address,
            hx,
            hy,
            hyaw,
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
    if b.status is not None:
        f.append("status=?")
        v.append(b.status)
    if b.ip_address is not None:
        f.append("ip_address=?")
        v.append(b.ip_address)
    if b.home_x is not None:
        f.append("home_x=?")
        v.append(b.home_x)
    if b.home_y is not None:
        f.append("home_y=?")
        v.append(b.home_y)
    if b.home_yaw is not None:
        f.append("home_yaw=?")
        v.append(b.home_yaw)
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
            "INSERT INTO Locations (location_code, rack, slot, loc_x, loc_y, loc_yaw) VALUES (?,?,?,?,?,?)",
            b.location_code,
            b.rack,
            b.slot,
            b.loc_x,
            b.loc_y,
            b.loc_yaw,
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
    if b.loc_x is not None:
        f.append("loc_x=?")
        v.append(b.loc_x)
    if b.loc_y is not None:
        f.append("loc_y=?")
        v.append(b.loc_y)
    if b.loc_yaw is not None:
        f.append("loc_yaw=?")
        v.append(b.loc_yaw)
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
            "INSERT INTO ScanLogs (robot_code, qr_code, scan_time) OUTPUT INSERTED.id VALUES (?,?,GETDATE())",
            b.robot_code,
            b.qr_code,
        )
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
# ORDERS + PICK TASKS
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/orders", tags=["Orders"])
def get_orders():
    sql = """
        SELECT o.id, o.order_code, o.status, o.assigned_robot,
               CONVERT(NVARCHAR, o.created_at, 120)   AS created_at,
               CONVERT(NVARCHAR, o.completed_at, 120)  AS completed_at,
               (SELECT COUNT(*) FROM OrderItems WHERE order_id=o.id) AS item_count,
               (SELECT COUNT(*) FROM OrderItems WHERE order_id=o.id AND status='PICKED') AS picked_count
        FROM Orders o ORDER BY o.id DESC
    """
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(sql)
        return rows_to_list(cur, cur.fetchall())


@app.get("/orders/{oid}", tags=["Orders"])
def get_order_detail(oid: int):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT o.id, o.order_code, o.status, o.assigned_robot,
                   CONVERT(NVARCHAR, o.created_at, 120)  AS created_at,
                   CONVERT(NVARCHAR, o.completed_at, 120) AS completed_at
            FROM Orders o WHERE o.id=?
        """,
            oid,
        )
        order = cur.fetchone()
        if not order:
            raise HTTPException(404, "Order not found")
        cols = [c[0] for c in cur.description]
        order_dict = dict(zip(cols, order))

        cur.execute(
            """
            SELECT oi.id, oi.product_id, oi.quantity, oi.picked_qty, oi.status,
                   p.product_code, p.name AS product_name, p.category
            FROM OrderItems oi
            LEFT JOIN Products p ON oi.product_id = p.id
            WHERE oi.order_id=? ORDER BY oi.id
        """,
            oid,
        )
        order_dict["items"] = rows_to_list(cur, cur.fetchall())

        cur.execute(
            """
            SELECT pt.id, pt.order_item_id, pt.location_id, pt.product_id,
                   pt.quantity, pt.seq, pt.status,
                   pt.nav_x, pt.nav_y, pt.nav_yaw,
                   l.location_code, l.rack, l.slot,
                   p.product_code, p.name AS product_name,
                   CONVERT(NVARCHAR, pt.scanned_at, 120) AS scanned_at,
                   CONVERT(NVARCHAR, pt.picked_at, 120)  AS picked_at
            FROM PickTasks pt
            LEFT JOIN Locations l ON pt.location_id = l.id
            LEFT JOIN Products  p ON pt.product_id  = p.id
            WHERE pt.order_id=? ORDER BY pt.seq
        """,
            oid,
        )
        order_dict["pick_tasks"] = rows_to_list(cur, cur.fetchall())

    return order_dict


@app.post("/orders", tags=["Orders"], status_code=201)
async def create_order(b: OrderCreate):
    """
    Create order + auto-generate optimized pick route.
    1. Insert Order + OrderItems
    2. For each item, find the best inventory location (highest stock)
    3. Run nearest-neighbor TSP to sequence the picks
    4. Insert PickTasks with nav coordinates
    5. Broadcast to dashboard
    """
    if not b.items:
        raise HTTPException(400, "Order must have at least one item")

    with get_connection() as conn:
        cur = conn.cursor()

        # Resolve robot: use specified or auto-assign first IDLE robot
        robot_code = b.assigned_robot
        if robot_code:
            cur.execute("SELECT robot_code FROM Robots WHERE robot_code=?", robot_code)
            if not cur.fetchone():
                raise HTTPException(400, f"Robot '{robot_code}' not found")
        else:
            cur.execute(
                "SELECT TOP 1 robot_code FROM Robots WHERE status='IDLE' ORDER BY id"
            )
            row = cur.fetchone()
            if row:
                robot_code = row[0]

        # 1. Create order
        cur.execute(
            "INSERT INTO Orders (order_code, status, assigned_robot) OUTPUT INSERTED.id VALUES (?,?,?)",
            b.order_code,
            "PENDING",
            robot_code,
        )
        order_id = int(cur.fetchone()[0])

        # 2. Create order items & find inventory locations
        items_for_routing = []
        for item in b.items:
            pid = item["product_id"]
            qty = item["quantity"]

            cur.execute(
                "INSERT INTO OrderItems (order_id, product_id, quantity) OUTPUT INSERTED.id VALUES (?,?,?)",
                order_id,
                pid,
                qty,
            )
            oi_id = int(cur.fetchone()[0])

            # Find best location: has this product, sufficient stock, prefer highest qty
            cur.execute(
                """
                SELECT TOP 1 i.location_id, i.quantity, l.location_code
                FROM Inventory i
                JOIN Locations l ON i.location_id = l.id
                WHERE i.product_id = ? AND i.quantity >= ?
                ORDER BY i.quantity DESC
            """,
                pid,
                qty,
            )
            row = cur.fetchone()
            if row:
                loc_id, inv_qty, loc_code = row
            else:
                # Fallback: pick any location with this product
                cur.execute(
                    """
                    SELECT TOP 1 i.location_id, i.quantity, l.location_code
                    FROM Inventory i
                    JOIN Locations l ON i.location_id = l.id
                    WHERE i.product_id = ?
                    ORDER BY i.quantity DESC
                """,
                    pid,
                )
                row = cur.fetchone()
                if row:
                    loc_id, inv_qty, loc_code = row
                else:
                    loc_id, loc_code = None, None

            items_for_routing.append(
                {
                    "order_item_id": oi_id,
                    "product_id": pid,
                    "quantity": qty,
                    "location_id": loc_id,
                    "location_code": loc_code,
                }
            )

        # 3. TSP route planning — start from assigned robot's home position
        routable = [i for i in items_for_routing if i["location_code"]]
        robot_home = get_robot_home(robot_code)
        route = plan_pick_route(routable, robot_home["x"], robot_home["y"])

        # 4. Insert PickTasks
        for seq, item in enumerate(route, start=1):
            coord = SHELF_COORDS.get(item["location_code"], HOME_COORD)
            cur.execute(
                """
                INSERT INTO PickTasks
                    (order_id, order_item_id, location_id, product_id, quantity, seq, status, nav_x, nav_y, nav_yaw)
                VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
                order_id,
                item["order_item_id"],
                item["location_id"],
                item["product_id"],
                item["quantity"],
                seq,
                "PENDING",
                coord["x"],
                coord["y"],
                coord["yaw"],
            )

        conn.commit()

    # 5. Broadcast
    detail = get_order_detail(order_id)
    await manager.broadcast({"type": "order_created", "data": detail})
    return {"status": "created", "order_id": order_id}


@app.post("/orders/{oid}/dispatch", tags=["Orders"])
async def dispatch_order(oid: int):
    """Mark order as IN_PROGRESS, assign robot as BUSY, return the pick route."""
    with get_connection() as conn:
        cur = conn.cursor()

        # Check order is PENDING
        cur.execute(
            "SELECT assigned_robot FROM Orders WHERE id=? AND status='PENDING'", oid
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(400, "Order not dispatchable (not PENDING)")
        robot_code = row[0]

        # Validate assigned robot is IDLE
        if robot_code:
            cur.execute("SELECT status FROM Robots WHERE robot_code=?", robot_code)
            r = cur.fetchone()
            if r and r[0] != "IDLE":
                raise HTTPException(
                    409, f"Robot '{robot_code}' is currently {r[0]}, cannot dispatch"
                )
            # Mark robot BUSY
            cur.execute(
                "UPDATE Robots SET status='BUSY' WHERE robot_code=?", robot_code
            )

        cur.execute("UPDATE Orders SET status='IN_PROGRESS' WHERE id=?", oid)
        conn.commit()

    detail = get_order_detail(oid)
    await manager.broadcast({"type": "order_dispatched", "data": detail})
    return detail


@app.post("/pick/scan", tags=["Orders"])
async def pick_scan_confirm(b: PickConfirm):
    """
    Robot scanned QR at a shelf during a pick mission.
    1. Find the active PickTask for this location
    2. Mark it SCANNED
    3. Also log into ScanLogs
    4. Broadcast update
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Find location by QR code
        cur.execute("SELECT id FROM Locations WHERE location_code=?", b.qr_code)
        loc_row = cur.fetchone()
        if not loc_row:
            raise HTTPException(404, f"Unknown location: {b.qr_code}")
        loc_id = loc_row[0]

        # Find the first PENDING pick task at this location for an IN_PROGRESS order
        cur.execute(
            """
            SELECT pt.id, pt.order_id, pt.order_item_id, pt.product_id, pt.quantity
            FROM PickTasks pt
            JOIN Orders o ON pt.order_id = o.id
            WHERE pt.location_id = ? AND pt.status = 'PENDING' AND o.status = 'IN_PROGRESS'
            ORDER BY o.id, pt.seq
        """,
            loc_id,
        )
        task = cur.fetchone()
        if not task:
            # No pending task — just log the scan normally
            cur.execute(
                "INSERT INTO ScanLogs (robot_code, qr_code, scan_time) VALUES (?,?,GETDATE())",
                b.robot_code,
                b.qr_code,
            )
            conn.commit()
            await manager.broadcast({"type": "pick_no_task", "qr_code": b.qr_code})
            return {
                "status": "logged",
                "message": "No pending pick task at this location",
            }

        pt_id, order_id, oi_id, product_id, pick_qty = task

        # Mark task as SCANNED
        cur.execute(
            "UPDATE PickTasks SET status='SCANNED', scanned_at=GETDATE() WHERE id=?",
            pt_id,
        )

        # Log scan
        cur.execute(
            "INSERT INTO ScanLogs (robot_code, qr_code, scan_time) VALUES (?,?,GETDATE())",
            b.robot_code,
            b.qr_code,
        )
        conn.commit()

    await manager.broadcast(
        {
            "type": "pick_scanned",
            "order_id": order_id,
            "pick_task_id": pt_id,
            "location": b.qr_code,
        }
    )
    return {"status": "scanned", "pick_task_id": pt_id, "order_id": order_id}


@app.post("/pick/{pt_id}/complete", tags=["Orders"])
async def pick_complete(pt_id: int):
    """
    Picking mechanism finished — mark task PICKED, decrement inventory,
    update order item, check if full order is complete.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute(
            """
            SELECT pt.order_id, pt.order_item_id, pt.location_id, pt.product_id, pt.quantity, pt.status
            FROM PickTasks pt WHERE pt.id=?
        """,
            pt_id,
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Pick task not found")
        order_id, oi_id, loc_id, product_id, pick_qty, status = row
        if status not in ("SCANNED", "PENDING"):
            raise HTTPException(400, f"Task already {status}")

        # Mark PICKED
        cur.execute(
            "UPDATE PickTasks SET status='PICKED', picked_at=GETDATE() WHERE id=?",
            pt_id,
        )

        # Update order item
        cur.execute(
            "UPDATE OrderItems SET picked_qty=picked_qty+?, status='PICKED' WHERE id=?",
            pick_qty,
            oi_id,
        )

        # Decrement inventory
        cur.execute(
            """
            UPDATE Inventory SET quantity = quantity - ?
            WHERE product_id = ? AND location_id = ? AND quantity >= ?
        """,
            pick_qty,
            product_id,
            loc_id,
            pick_qty,
        )

        # Check: all items in this order picked? (atomic check-and-update)
        cur.execute(
            """
            UPDATE Orders SET status='COMPLETED', completed_at=GETDATE()
            WHERE id=? AND NOT EXISTS (
                SELECT 1 FROM PickTasks WHERE order_id=? AND status != 'PICKED'
            )
        """,
            order_id,
            order_id,
        )
        remaining_check = cur.rowcount  # 1 if order completed, 0 if tasks remain
        if remaining_check > 0:
            # Release robot back to IDLE
            cur.execute("SELECT assigned_robot FROM Orders WHERE id=?", order_id)
            ar = cur.fetchone()
            if ar and ar[0]:
                cur.execute("UPDATE Robots SET status='IDLE' WHERE robot_code=?", ar[0])

        conn.commit()

    detail = get_order_detail(order_id)
    order_complete = remaining_check > 0
    msg_type = "order_completed" if order_complete else "pick_completed"
    await manager.broadcast({"type": msg_type, "data": detail, "pick_task_id": pt_id})
    return {"status": "picked", "order_complete": order_complete}


@app.delete("/orders/{oid}", tags=["Orders"])
def delete_order(oid: int):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM PickTasks WHERE order_id=?", oid)
        cur.execute("DELETE FROM OrderItems WHERE order_id=?", oid)
        cur.execute("DELETE FROM Orders WHERE id=?", oid)
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        conn.commit()
    return {"status": "deleted"}


# ─────────────────────────────────────────────────────────────────────────────
# CLOUD BRIDGE — Pi agent connects outbound to server for internet control
# ─────────────────────────────────────────────────────────────────────────────

# Optional shared secret: set BRIDGE_TOKEN env-var on both server and Pi.
# If unset, any client can register as a robot agent (fine for local dev).
BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "")


class RobotBridge:
    """Hub linking ONE Pi agent WebSocket to N dashboard relay sockets for a robot."""

    def __init__(self, robot_code: str):
        self.robot_code = robot_code
        self.agent_ws: WebSocket | None = None
        self.dashboard_clients: list[WebSocket] = []

    async def forward_to_dashboards(self, data: str):
        """Send a message from the Pi agent to every connected dashboard client."""
        dead: list[WebSocket] = []
        for ws in self.dashboard_clients:
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.dashboard_clients.remove(ws)

    async def forward_to_agent(self, data: str):
        """Send a message from a dashboard client to the Pi agent."""
        if self.agent_ws:
            try:
                await self.agent_ws.send_text(data)
            except Exception:
                self.agent_ws = None


# Global registry: robot_code → RobotBridge
_robot_bridges: dict[str, RobotBridge] = {}


def _get_bridge(code: str) -> RobotBridge:
    if code not in _robot_bridges:
        _robot_bridges[code] = RobotBridge(code)
    return _robot_bridges[code]


@app.websocket("/ws/robot-agent/{robot_code}")
async def robot_agent_endpoint(ws: WebSocket, robot_code: str, token: str = Query("")):
    """
    **Pi bridge agent** connects here (outbound from Pi → server).

    The agent simultaneously connects to local rosbridge (ws://localhost:9090)
    and this endpoint. It relays rosbridge traffic in both directions so the
    dashboard's /ros-proxy can reach the robot over the internet.

    Query params:
      ?token=<BRIDGE_TOKEN>   (required only when BRIDGE_TOKEN env-var is set)
    """
    # ── Auth ──
    if BRIDGE_TOKEN and token != BRIDGE_TOKEN:
        await ws.close(code=1008, reason="Invalid bridge token")
        return

    bridge = _get_bridge(robot_code)

    # Only one agent per robot at a time
    if bridge.agent_ws is not None:
        await ws.close(code=1008, reason=f"Agent already connected for {robot_code}")
        return

    await ws.accept()
    bridge.agent_ws = ws
    print(f"[CLOUD] Pi agent CONNECTED for {robot_code}")

    try:
        while True:
            data = await ws.receive_text()
            # Relay rosbridge response from Pi → all dashboard clients
            await bridge.forward_to_dashboards(data)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[CLOUD] Agent error for {robot_code}: {exc}")
    finally:
        bridge.agent_ws = None
        print(f"[CLOUD] Pi agent DISCONNECTED for {robot_code}")


@app.get("/robot-agents", tags=["Cloud Bridge"])
async def list_robot_agents():
    """Return which robots currently have a cloud bridge agent connected."""
    return {
        code: bridge.agent_ws is not None for code, bridge in _robot_bridges.items()
    }


# ─────────────────────────────────────────────────────────────────────────────
# PROXY — Centralise ROS Bridge + Camera through this server
# ─────────────────────────────────────────────────────────────────────────────

# Allowed ports that the proxy may connect to on robot hosts.
_ALLOWED_PROXY_PORTS = {9090, 5000}


def _resolve_robot_ip(robot_code: str) -> str:
    """Look up a robot's IP address from the Robots table. Raises HTTPException on failure."""
    if not robot_code:
        raise HTTPException(400, "Missing robot code")
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT ip_address FROM Robots WHERE robot_code=?", robot_code)
        row = cur.fetchone()
    if not row or not row[0]:
        raise HTTPException(404, f"Robot '{robot_code}' not found or has no IP address")
    return row[0]


@app.websocket("/ros-proxy")
async def ros_bridge_proxy(ws_client: WebSocket, robot: str = Query(...)):
    """
    Bidirectional WebSocket proxy: browser ↔ server ↔ Pi rosbridge.

    Two modes (automatic):
      1. **Cloud Bridge** — if a Pi agent is connected via /ws/robot-agent/{code},
         relay through it.  Works over the internet.
      2. **LAN Direct**  — otherwise, open a direct WebSocket to ws://<ip>:9090.

    Query parameter: ?robot=AMR_01
    """

    def _log_debug_publish_frame(raw: str):
        """Log selected publish frames for quick debugging."""
        try:
            obj = json.loads(raw)
        except Exception:
            return
        if obj.get("op") != "publish":
            return
        topic = obj.get("topic")
        msg = obj.get("msg") or {}
        if topic == "/slam/command":
            payload = msg.get("data")
            print(f"[ROS-PROXY] TX /slam/command ({robot}) -> {payload}")
            return
        if topic == "/cmd_vel":
            lin = (msg.get("linear") or {}).get("x")
            ang = (msg.get("angular") or {}).get("z")
            print(
                f"[ROS-PROXY] TX /cmd_vel ({robot}) -> linear.x={lin}, angular.z={ang}"
            )

    # ── Try Cloud Bridge first ────────────────────────────────────────────
    bridge = _robot_bridges.get(robot)
    if bridge and bridge.agent_ws is not None:
        await ws_client.accept()
        bridge.dashboard_clients.append(ws_client)
        print(
            f"[ROS-PROXY] Cloud bridge for {robot} (dashboards: {len(bridge.dashboard_clients)})"
        )
        try:
            while True:
                data = await ws_client.receive_text()
                _log_debug_publish_frame(data)
                await bridge.forward_to_agent(data)
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            print(f"[ROS-PROXY] Cloud relay error for {robot}: {exc}")
        finally:
            if ws_client in bridge.dashboard_clients:
                bridge.dashboard_clients.remove(ws_client)
            print(f"[ROS-PROXY] Cloud session ended for {robot}")
        return

    # ── Fall back to LAN direct connection ────────────────────────────────
    try:
        ip = _resolve_robot_ip(robot)
    except HTTPException:
        await ws_client.close(code=1008, reason=f"Robot '{robot}' not found or no IP")
        return

    ros_url = f"ws://{ip}:9090"
    await ws_client.accept()
    print(f"[ROS-PROXY] LAN direct for {robot} → {ros_url}")

    try:
        async with websockets.connect(ros_url, max_size=16 * 1024 * 1024) as ws_ros:

            async def browser_to_ros():
                """Forward messages from the browser to rosbridge."""
                try:
                    while True:
                        data = await ws_client.receive_text()
                        _log_debug_publish_frame(data)
                        await ws_ros.send(data)
                except WebSocketDisconnect:
                    pass
                except Exception:
                    pass

            async def ros_to_browser():
                """Forward messages from rosbridge to the browser."""
                try:
                    async for message in ws_ros:
                        if isinstance(message, str):
                            await ws_client.send_text(message)
                        else:
                            await ws_client.send_bytes(message)
                except websockets.ConnectionClosed:
                    pass
                except Exception:
                    pass

            # Run both relay directions concurrently; stop when either side closes.
            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(browser_to_ros()),
                    asyncio.create_task(ros_to_browser()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()

    except (OSError, websockets.InvalidURI, websockets.InvalidHandshake) as exc:
        print(f"[ROS-PROXY] Cannot reach rosbridge at {ros_url}: {exc}")
        try:
            await ws_client.close(
                code=1011, reason=f"Cannot reach rosbridge: {exc}"[:120]
            )
        except Exception:
            pass
    except Exception as exc:
        print(f"[ROS-PROXY] Unexpected error: {exc}")
        try:
            await ws_client.close(code=1011, reason="Internal proxy error")
        except Exception:
            pass
    finally:
        print(f"[ROS-PROXY] Session ended for robot '{robot}'")


@app.get("/camera-proxy", tags=["Proxy"])
async def camera_stream_proxy(robot: str = Query(...)):
    """
    Proxy the MJPEG camera stream from a robot's Pi (port 5000).

    The dashboard loads this URL in an <img> tag instead of hitting the Pi directly.
    Query parameter: ?robot=AMR_01
    """
    ip = _resolve_robot_ip(robot)
    camera_url = f"http://{ip}:5000/video"

    async def _stream():
        try:
            async with httpx.AsyncClient() as client:
                async with client.stream(
                    "GET",
                    camera_url,
                    timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0),
                ) as resp:
                    if resp.status_code != 200:
                        return
                    async for chunk in resp.aiter_bytes(chunk_size=8192):
                        yield chunk
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout) as exc:
            print(f"[CAM-PROXY] Cannot reach camera at {camera_url}: {exc}")
        except Exception as exc:
            print(f"[CAM-PROXY] Stream error: {exc}")

    return StreamingResponse(
        _stream(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


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


@app.post("/seed-demo", tags=["Utility"])
def seed_demo():
    """
    Populate Robots, Locations, Products, Inventory with virtual warehouse data.
    Safe to call multiple times — skips if Locations already seeded.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM Locations")
        if cur.fetchone()[0] > 0:
            return {"status": "already_seeded"}

        # Robots — one real + two planned for future expansion
        robots = [
            (
                "AMR_01",
                "TurtleBot3 — main floor robot",
                "IDLE",
                "192.168.1.56",
                HOME_COORD["x"],
                HOME_COORD["y"],
                HOME_COORD["yaw"],
            ),
            (
                "AMR_02",
                "TurtleBot3 — zone B backup",
                "OFFLINE",
                "192.168.1.57",
                0.997,
                -0.417,
                0.0,
            ),
            (
                "AMR_03",
                "TurtleBot3 — maintenance/testing",
                "OFFLINE",
                "192.168.1.58",
                1.010,
                0.557,
                1.57,
            ),
        ]
        for rc, desc, st, ip, hx, hy, hyaw in robots:
            cur.execute(
                "INSERT INTO Robots (robot_code, description, status, ip_address, home_x, home_y, home_yaw) VALUES (?,?,?,?,?,?,?)",
                rc,
                desc,
                st,
                ip,
                hx,
                hy,
                hyaw,
            )

        # 12 shelf locations matching SHELF_COORDS
        locations = [
            ("RACK_A_01", "A", "01"),
            ("RACK_A_02", "A", "02"),
            ("RACK_A_03", "A", "03"),
            ("RACK_B_01", "B", "01"),
            ("RACK_B_02", "B", "02"),
            ("RACK_B_03", "B", "03"),
            ("RACK_C_01", "C", "01"),
            ("RACK_C_02", "C", "02"),
            ("RACK_C_03", "C", "03"),
            ("RACK_D_01", "D", "01"),
            ("RACK_D_02", "D", "02"),
            ("RACK_D_03", "D", "03"),
        ]
        for lc, rack, slot in locations:
            cur.execute(
                "INSERT INTO Locations (location_code, rack, slot) VALUES (?,?,?)",
                lc,
                rack,
                slot,
            )

        # 12 products
        products = [
            ("PRD-001", "Widget A", "Widget"),
            ("PRD-002", "Widget B", "Widget"),
            ("PRD-003", "Gizmo Alpha", "Gizmo"),
            ("PRD-004", "Gizmo Beta", "Gizmo"),
            ("PRD-005", "Sensor Unit X", "Sensor"),
            ("PRD-006", "Sensor Unit Y", "Sensor"),
            ("PRD-007", "Motor DC-12V", "Actuator"),
            ("PRD-008", "Motor Stepper", "Actuator"),
            ("PRD-009", "Battery LiPo", "Power"),
            ("PRD-010", "Battery NiMH", "Power"),
            ("PRD-011", "PCB Main", "Electronics"),
            ("PRD-012", "PCB Sensor", "Electronics"),
        ]
        for pc, name, cat in products:
            cur.execute(
                "INSERT INTO Products (product_code, name, category) VALUES (?,?,?)",
                pc,
                name,
                cat,
            )

        # Inventory — one product per location, random-ish stock
        stocks = [25, 40, 15, 30, 50, 20, 10, 35, 45, 18, 22, 38]
        for idx in range(12):
            cur.execute(
                "INSERT INTO Inventory (product_id, location_id, quantity) VALUES (?,?,?)",
                idx + 1,
                idx + 1,
                stocks[idx],
            )

        conn.commit()
    return {
        "status": "seeded",
        "robots": 3,
        "locations": 12,
        "products": 12,
        "inventory": 12,
    }


@app.get("/", include_in_schema=False)
def serve_ui():
    path = os.path.join(os.path.dirname(__file__), "index.html")
    if not os.path.exists(path):
        raise HTTPException(404, "index.html not found")
    return FileResponse(path, media_type="text/html")
