# Warehouse AMR Dashboard

A full-stack **Autonomous Mobile Robot (AMR) control dashboard** for warehouse pick-and-pack operations. Combines a FastAPI backend, a real-time single-page dashboard, ROS 2 integration via rosbridge, SLAM mapping, and a 3D simulation viewer.

> **Robot firmware / Pi workspace** — see the companion repo [Turtlebot3PI-master](https://github.com/Hug-leo/Turtlebot3PI-master) for the ROS 2 packages that run on the Raspberry Pi.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Folder Structure](#folder-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Database Setup](#database-setup)
- [Running](#running)
- [Dashboard Tabs](#dashboard-tabs)
- [API Reference](#api-reference)
- [ROS 2 Topics & Services](#ros-2-topics--services)
- [SLAM & Map Management](#slam--map-management)
- [3D Simulation Viewer](#3d-simulation-viewer)
- [Workflow: Order → Pick → Complete](#workflow-order--pick--complete)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

---

## Features

| Category              | Details                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fleet Management**  | Register robots, assign home positions, track status (IDLE / BUSY / OFFLINE), per-robot IP and rosbridge connections                           |
| **Warehouse CRUD**    | Full CRUD for Robots, Locations, Products, Inventory, Scan Logs via REST API + live UI tables                                                  |
| **Order System**      | Create orders with multiple items, auto-locate inventory, TSP-optimized pick routes, assign & dispatch to robots                               |
| **Pick Workflow**     | QR-code scan confirmation at each rack, auto-decrement inventory, per-item tracking, auto-complete orders                                      |
| **Multi-Robot Fleet** | Connect to multiple robots simultaneously via rosbridge WebSocket, per-robot connection status indicators                                      |
| **AMR Control**       | Manual teleop (keyboard + on-screen joystick), click-to-navigate goal setting, waypoint mission tool, 2D map canvas                            |
| **SLAM & Mapping**    | Start/stop SLAM, save maps, list saved maps, load a map + launch Nav2 — all from the dashboard                                                 |
| **3D Simulation**     | Three.js real-time 3D viewer with URDF loading, LiDAR point cloud, navigation path, waypoint markers, occupancy map overlay, click-to-set-goal |
| **Real-time Updates** | WebSocket push for scan events, order status changes, pick completions                                                                         |
| **Camera Feed**       | MJPEG stream display from Pi QR scanner or local USB camera                                                                                    |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    PC (Windows/Linux)                        │
│                                                             │
│  ┌──────────────┐     ┌──────────────────────────────────┐  │
│  │  SQL Server   │◄────│  FastAPI Backend (server.py)      │  │
│  │  WarehouseDB  │     │  - REST API (31 endpoints)       │  │
│  └──────────────┘     │  - WebSocket /ws                  │  │
│                        │  - Serves index.html              │  │
│                        └─────────┬────────────────────────┘  │
│                                  │ HTTP :8000                │
│                        ┌─────────▼────────────────────────┐  │
│                        │  Dashboard (index.html)           │  │
│                        │  - 10 tabs, single-page app       │  │
│                        │  - roslib.js → rosbridge WS       │  │
│                        │  - Three.js 3D simulation         │  │
│                        └─────────┬────────────────────────┘  │
└──────────────────────────────────┼──────────────────────────┘
                                   │ ws://PI_IP:9090
┌──────────────────────────────────▼──────────────────────────┐
│              Raspberry Pi (ROS 2 Humble)                     │
│                                                             │
│  ┌─────────────────────┐  ┌──────────────────────────────┐  │
│  │  rosbridge_server    │  │  slam_manager_node            │  │
│  │  (WebSocket :9090)   │  │  - SLAM start/stop/save       │  │
│  └─────────────────────┘  │  - Map load + Nav2 launch      │  │
│                            └──────────────────────────────┘  │
│  ┌─────────────────────┐  ┌──────────────────────────────┐  │
│  │  diff_drive_ctrl     │  │  Nav2 bringup (optional)      │  │
│  │  (motor controller)  │  │  - AMCL, planner, controller  │  │
│  └─────────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

### PC

| Layer      | Technology                                             |
| ---------- | ------------------------------------------------------ |
| Backend    | Python 3.10+, FastAPI, Uvicorn                         |
| Database   | Microsoft SQL Server (Express), pyodbc, ODBC Driver 17 |
| Frontend   | Vanilla HTML/CSS/JS (single file), Chart.js            |
| 3D Engine  | Three.js 0.160.0, OrbitControls, urdf-loader 0.12.4    |
| ROS Bridge | roslib.js (CDN)                                        |
| Extras     | Flask (MJPEG stream utility)                           |

---

## Folder Structure

```
Warehouse/
├── server.py                 # FastAPI backend (31 routes, 8 DB tables)
├── index.html                # Dashboard SPA (~4000+ lines)
├── README.md                 # This file
├── generate_qr_codes.py      # Generates QR code PNGs for all 12 warehouse locations
├── pi_qr_scanner.py          # Pi agent: webcam QR scanner + POST /scan + MJPEG
├── MJPEG stream on PC.py     # Flask local camera MJPEG server (:5001)
├── qr_codes/                 # Generated QR code images
└── .gitignore
```

---

## Prerequisites

- **Python 3.10+**
- **Microsoft SQL Server** (Express edition is fine)
- **ODBC Driver 17 for SQL Server** — [Download](https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server)
- **Browser** with WebSocket support (Chrome, Firefox, Edge)

---

## Installation

```bash
# Clone repo
git clone https://github.com/Hug-leo/WarehouseUI.git Warehouse
cd Warehouse

# Create virtual environment
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # Linux/Mac

# Install Python dependencies
pip install fastapi uvicorn pyodbc

# (Optional) For the local MJPEG camera stream
pip install flask opencv-python
```

---

## Database Setup

1. Open SQL Server Management Studio (SSMS) or `sqlcmd`.
2. Create the database:
   ```sql
   CREATE DATABASE WarehouseDB;
   ```
3. Tables are **auto-created** on first run of `server.py`. The backend runs `CREATE TABLE IF NOT EXISTS` (via `IF NOT EXISTS` checks) for all 8 tables:
   - `Robots` — robot_code, description, status, home_x/y/yaw, ip_address
   - `Locations` — location_code, zone, x, y, description
   - `Products` — sku, name, description
   - `Inventory` — product_id, location_id, quantity
   - `ScanLogs` — robot_code, qr_code, scan_time
   - `Orders` — order_code, status, assigned_robot, timestamps
   - `OrderItems` — order_id, product_id, quantity, picked_qty, status
   - `PickTasks` — order_id, order_item_id, location/product/quantity, seq, nav coords, timestamps

4. **(Optional)** Seed demo data:
   ```bash
   curl -X POST http://localhost:8000/seed-demo
   ```
   Creates 3 robots (AMR_01, AMR_02, AMR_03), 12 locations (RACK_A1–D3), 12 products, and inventory.

---

## Running

### Start the backend

```bash
cd Warehouse
uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

### Open the dashboard

Navigate to: **http://localhost:8000**

> For Pi-side setup (rosbridge, SLAM manager, motor controller), see the [Turtlebot3PI-master](https://github.com/Hug-leo/Turtlebot3PI-master) repo.

---

## Dashboard Tabs

| #   | Tab             | Description                                                                                         |
| --- | --------------- | --------------------------------------------------------------------------------------------------- |
| 1   | **Live View**   | Real-time scan log feed via WebSocket, table auto-updates                                           |
| 2   | **Robots**      | CRUD for robot fleet — code, status, home position, IP address                                      |
| 3   | **Locations**   | CRUD for warehouse rack locations — code, zone, coordinates                                         |
| 4   | **Products**    | CRUD for product catalog — SKU, name, description                                                   |
| 5   | **Inventory**   | Manage stock levels per product per location                                                        |
| 6   | **Scan Logs**   | View all QR scan history                                                                            |
| 7   | **Camera**      | MJPEG video feed from Pi or local camera                                                            |
| 8   | **Orders**      | Create orders, view pick tasks, dispatch to robots, track completion                                |
| 9   | **AMR Control** | Multi-robot fleet connection, teleop, 2D map canvas, SLAM controls, waypoint missions, PID tuning   |
| 10  | **Simulation**  | 3D Three.js viewer — URDF robot, LiDAR cloud, nav path, waypoints, occupancy map, click-to-navigate |

---

## API Reference

### Utility

| Method | Endpoint     | Description                                              |
| ------ | ------------ | -------------------------------------------------------- |
| `GET`  | `/`          | Serve dashboard (index.html)                             |
| `GET`  | `/health`    | Health check                                             |
| `POST` | `/seed-demo` | Populate demo data (3 robots, 12 locations, 12 products) |
| `WS`   | `/ws`        | WebSocket — real-time push for scans, orders, picks      |

### CRUD (Robots, Locations, Products, Inventory, ScanLogs)

Each entity supports:

| Method   | Endpoint        | Description      |
| -------- | --------------- | ---------------- |
| `GET`    | `/<table>`      | List all rows    |
| `POST`   | `/<table>`      | Create new row   |
| `PUT`    | `/<table>/{id}` | Update row by ID |
| `DELETE` | `/<table>/{id}` | Delete row by ID |

Tables: `robots`, `locations`, `products`, `inventory`, `scanlogs`

### Orders & Picking

| Method   | Endpoint                 | Description                                                               |
| -------- | ------------------------ | ------------------------------------------------------------------------- |
| `GET`    | `/orders`                | List all orders with items and tasks                                      |
| `GET`    | `/orders/{oid}`          | Get order detail with items and pick tasks                                |
| `POST`   | `/orders`                | Create order — auto-locates inventory, builds TSP-optimized pick route    |
| `POST`   | `/orders/{oid}/dispatch` | Dispatch order to robot — marks IN_PROGRESS, assigns robot                |
| `POST`   | `/pick/scan`             | QR scan at rack — confirms pick task location                             |
| `POST`   | `/pick/{pt_id}/complete` | Mark pick done — decrements inventory, auto-completes order if all picked |
| `DELETE` | `/orders/{oid}`          | Delete order and associated tasks                                         |

### Scan

| Method | Endpoint | Description                                                              |
| ------ | -------- | ------------------------------------------------------------------------ |
| `POST` | `/scan`  | Log a QR scan — returns enriched data with robot, location, product info |

---

## ROS 2 Topics & Services

The dashboard subscribes to these topics via rosbridge:

| Topic                              | Type                                      | Description                                      |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| `/cmd_vel`                         | `geometry_msgs/Twist`                     | Velocity commands (teleop publish)               |
| `/goal_pose`                       | `geometry_msgs/PoseStamped`               | Navigation goal (click-to-navigate)              |
| `/amcl_pose`                       | `geometry_msgs/PoseWithCovarianceStamped` | Robot localized pose                             |
| `/imu`                             | `sensor_msgs/Imu`                         | IMU orientation + accelerometer                  |
| `/odom`                            | `nav_msgs/Odometry`                       | Wheel odometry                                   |
| `/map`                             | `nav_msgs/OccupancyGrid`                  | Occupancy grid (QoS: reliable + transient_local) |
| `/scan`                            | `sensor_msgs/LaserScan`                   | LiDAR range data                                 |
| `/plan`                            | `nav_msgs/Path`                           | Planned navigation path                          |
| `/slam/command`                    | `std_msgs/String`                         | SLAM manager commands                            |
| `/slam/status`                     | `std_msgs/String`                         | SLAM manager status feedback                     |
| `/slam/map_list`                   | `std_msgs/String`                         | JSON array of saved map names                    |
| `/navigate_to_pose/_action/status` | `action_msgs/GoalStatusArray`             | Nav2 action status                               |

---

## SLAM & Map Management

The dashboard's AMR Control tab includes a **SLAM / Map Manager** card:

1. **Start SLAM** — begins slam_toolbox mapping. The robot's LiDAR data builds a map in real-time (visible on the 2D canvas).
2. **Save Map** — saves the current map with a custom name to `~/maps/` on the Pi.
3. **Stop SLAM** — kills the SLAM process.
4. **Load Map & Navigate** — select a saved map from the dropdown, launches Nav2 with that map. Enables autonomous navigation (click-to-navigate, waypoint missions).
5. **Stop Navigation** — kills Nav2 processes.

> **Note:** SLAM and Nav2 are mutually exclusive. Starting SLAM stops Nav2, and loading a map stops SLAM.

---

## 3D Simulation Viewer

The **Simulation** tab (Tab 10) provides a real-time 3D visualization:

- **Robot model** — Load via URDF file, URL, or use the built-in TurtleBot3 model. Pose syncs with live `robotX/Y/Yaw` from `/amcl_pose` or `/odom`.
- **LiDAR point cloud** — Color-coded by distance (warm = close, cool = far), toggleable.
- **Navigation path** — Cyan 3D line from the `/plan` topic, toggleable.
- **Waypoint markers** — Colored spheres for mission waypoints (orange = pending, green = active, grey = completed), toggleable.
- **Occupancy map** — Map overlay projected on the ground plane.
- **Click-to-set-goal** — Enter goal mode, click on the ground to send Nav2 goals.
- **Camera controls** — Orbit, reset, top-down view, follow-robot mode.
- **Scene controls** — Toggle grid, axes, map, LiDAR, path, waypoints; change background color.
- **Fleet list** — Shows all registered robots and their status.

Three.js and dependencies are lazy-loaded on first tab visit to keep initial page load fast.

---

## Workflow: Order → Pick → Complete

```
1. CREATE ORDER         POST /orders  (items: [{product_id, quantity}, ...])
   └─ Auto-finds inventory locations
   └─ Plans TSP-optimized pick route
   └─ Creates PickTask per item with nav coordinates

2. DISPATCH             POST /orders/{id}/dispatch
   └─ Assigns available robot (IDLE → BUSY)
   └─ Order status: PENDING → IN_PROGRESS
   └─ Returns pick route with nav waypoints

3. ROBOT NAVIGATES      Dashboard sends Nav2 goals for each waypoint

4. QR SCAN AT RACK      POST /pick/scan  (robot_code, qr_code)
   └─ Matches scan to pending pick task at that location
   └─ Task status: PENDING → SCANNED

5. PICK COMPLETE        POST /pick/{task_id}/complete
   └─ Task status: SCANNED → PICKED
   └─ Inventory decremented
   └─ If all tasks picked → Order: COMPLETED, Robot: BUSY → IDLE

All state changes broadcast via WebSocket to connected dashboards.
```

---

## Configuration

### Database Connection (`server.py`)

Edit `DB_CONFIG` at the top of `server.py`:

```python
DB_CONFIG = {
    "driver": "ODBC Driver 17 for SQL Server",
    "server": r"YOUR_SERVER\SQLEXPRESS",
    "database": "WarehouseDB",
    "trusted": True,
}
```

### Robot IP Addresses

Set per-robot IP in the **Robots** CRUD tab. The dashboard connects to `ws://<ip>:9090` for rosbridge.

### MJPEG Camera URL

In the AMR Control tab, the camera feed URL defaults to:

```
http://<robot_ip>:8080/stream.mjpeg
```

### Shelf Coordinates

The `SHELF_COORDS` dictionary in `server.py` maps location codes to nav coordinates (x, y, yaw) used for pick task navigation.

---

## Troubleshooting

| Problem                         | Solution                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Map disappears on connect**   | QoS mismatch — the dashboard uses `durability: 1, reliability: 1` (transient_local + reliable) for `/map` topic. Ensure your map_server publishes with matching QoS.                        |
| **Cannot connect to rosbridge** | Verify rosbridge is running on the Pi (`ros2 launch rosbridge_server rosbridge_websocket_launch.xml`) and the IP/port are correct. Check firewall allows port 9090.                         |
| **SLAM won't start**            | Ensure `slam_manager` node is running on the Pi (see [Turtlebot3PI-master](https://github.com/Hug-leo/Turtlebot3PI-master)). SLAM and Nav2 are mutually exclusive — stop Nav2 first.        |
| **Database tables not created** | Ensure SQL Server is running and the `WarehouseDB` database exists. Check ODBC Driver 17 is installed. Verify trusted connection is allowed.                                                |
| **3D scene blank**              | Check browser console for Three.js CDN loading errors. The simulation lazy-loads scripts on first tab visit.                                                                                |
| **Robot not moving**            | Verify `diff_drive_controller` is running on the Pi (see [Turtlebot3PI-master](https://github.com/Hug-leo/Turtlebot3PI-master)). Check `/cmd_vel` messages with `ros2 topic echo /cmd_vel`. |
| **Orders stuck at IN_PROGRESS** | All pick tasks must be scanned and completed. Check `/orders/{id}` for task statuses.                                                                                                       |
| **WebSocket disconnects**       | The dashboard auto-reconnects every 3 seconds. If the server is down, wait for it to restart.                                                                                               |

---

## License

This project is intended for educational and internal use.
