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

        # 1. Create order
        cur.execute(
            "INSERT INTO Orders (order_code, status, assigned_robot) OUTPUT INSERTED.id VALUES (?,?,?)",
            b.order_code,
            "PENDING",
            b.assigned_robot,
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

        # 3. TSP route planning
        routable = [i for i in items_for_routing if i["location_code"]]
        route = plan_pick_route(routable)

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
    """Mark order as IN_PROGRESS and return the pick route for the robot."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE Orders SET status='IN_PROGRESS' WHERE id=? AND status='PENDING'",
            oid,
        )
        if cur.rowcount == 0:
            raise HTTPException(400, "Order not dispatchable (not PENDING)")
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

        # Check: all items in this order picked?
        cur.execute(
            """
            SELECT COUNT(*) FROM PickTasks WHERE order_id=? AND status != 'PICKED'
        """,
            order_id,
        )
        remaining = cur.fetchone()[0]
        if remaining == 0:
            cur.execute(
                "UPDATE Orders SET status='COMPLETED', completed_at=GETDATE() WHERE id=?",
                order_id,
            )

        conn.commit()

    detail = get_order_detail(order_id)
    msg_type = "order_completed" if remaining == 0 else "pick_completed"
    await manager.broadcast({"type": msg_type, "data": detail, "pick_task_id": pt_id})
    return {"status": "picked", "order_complete": remaining == 0}


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
    Populate Locations, Products, Inventory with virtual warehouse data.
    Safe to call multiple times — skips if Locations already seeded.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM Locations")
        if cur.fetchone()[0] > 0:
            return {"status": "already_seeded"}

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
    return {"status": "seeded", "locations": 12, "products": 12, "inventory": 12}


@app.get("/", include_in_schema=False)
def serve_ui():
    path = os.path.join(os.path.dirname(__file__), "index.html")
    if not os.path.exists(path):
        raise HTTPException(404, "index.html not found")
    return FileResponse(path, media_type="text/html")
