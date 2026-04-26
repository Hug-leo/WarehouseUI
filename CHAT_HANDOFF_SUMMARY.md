# Warehouse AMR Dashboard - Chat Handoff Summary

## 13. 2026-04-22: QR Scan, Order Completion, and Frontend Robustness

### Objectives

- Ensure the QR scan → order completion workflow is robust and provides real-time feedback in the dashboard.
- Add clear UI/logic for wrong-shelf scans and order completion.
- Diagnose and fix persistent frontend “Connecting to server” bug.
- Map all code locations for scan/order logic for future handoff.

### Actions Taken

- Verified Pi-side QR scanner posts to backend `/pick/scan` and `/pick/{id}/complete` endpoints.
- Confirmed backend (server.py) marks pick as SCANNED, detects wrong shelf, and marks as PICKED when correct.
- Ensured backend broadcasts real-time events (`pick_scanned`, `pick_wrong_shelf`, `order_completed`) via WebSocket.
- Confirmed frontend (index.html) handles all events:
  - Shows warning light and UI alarm for wrong shelf.
  - Flashes order row and auto-refreshes Orders tab on completion.
  - WebSocket connection watchdog added for robust reconnects.
- Diagnosed frontend bug: “Connecting to server” stuck due to JS syntax error (duplicate parameter in `viewOrder`).
- Fixed JS error, added error feedback, and verified dashboard now connects and updates as expected.
- Used Node.js, PowerShell, and Playwright to verify frontend and backend state.

### Code Locations

- **Backend:** `server.py` (`/pick/scan`, `/pick/{id}/complete`, WebSocket manager)
- **Pi agent:** `pi_bridge_agent.py` (QR scan logic, posts to backend)
- **Frontend:** `index.html` (WebSocket, UI feedback, order/scan event handlers)

### Status

- QR scan → order completion workflow is fully implemented and tested.
- Wrong shelf detection and UI alarm are in place.
- Orders tab auto-refreshes and flashes on completion.
- WebSocket connection is robust and self-healing.
- All major user requests for this workflow have been addressed and verified.

---

Date: 2026-04-18
Workspace: e:/Warehouse

## 1. Project Understanding Completed

- Read and summarized the project architecture from README.
- Confirmed 3-layer flow:
  - Web UI (commands + visualization)
  - slam_manager_node (orchestration)
  - diff_drive_controller (motor bridge)

## 2. map_list / SLAM UI Command Path Debugging

### Problem

- Saved maps were not showing in the UI dropdown.

### Actions taken

- Traced publish/subscribe path end-to-end:
  - Pi publishes /slam/map_list in slam_manager_node.
  - UI subscribes /slam/map_list and populates dropdown.
  - UI requests list via /slam/command.
- Added extensive UI diagnostics in index.html to log:
  - map_list receive payload shape
  - parsing flow
  - dropdown update status
- Aligned command string to list_map in UI.
- Kept backward compatibility in slam_manager_node for both list_map and list_maps.

### Root cause found

- QoS incompatibility on /slam/map_list (Durability mismatch).

### Fix applied

- Restored /slam/map_list publisher to TRANSIENT_LOCAL in slam_manager_node.
- Kept map list publishing request-driven (no periodic auto-publish).

## 3. ROS Proxy Verification and Observability

### Problem

- Needed proof whether UI commands were actually sent over remote connection.

### Actions taken

- Added server-side ros-proxy logging in server.py for:
  - /slam/command publish frames
  - /cmd_vel publish frames (linear.x / angular.z)
- Added delayed map-list request retries after ROS connect in UI to avoid discovery race.

### Outcome

- Confirmed from logs that UI was sending both list_map and cmd_vel.

## 4. rosbridge Conflict Resolution

### Problem

- On Pi: rosbridge showed "Address already in use" and behavior was inconsistent.

### Root cause

- Two rosbridge processes were running at the same time.

### Outcome

- After stopping duplicate process and restarting cleanly, command transport worked.

## 5. Save Map Failure Investigation

### Problem

- Save map failed while SLAM was running.

### Actions taken in slam_manager_node.py

- Added checks and diagnostics in save path:
  - Verify SLAM process alive before save.
  - Pre-check for /map availability.
  - Increased save timeouts.
  - Improved state/error messages for UI.
- Reworked map_saver execution to stream live stdout/stderr using Popen.
- Fixed crash bug:
  - Replaced invalid logger.exception call (not available on RcutilsLogger).
  - Added explicit TimeoutExpired handling for /map pre-check.

### Outcome

- Save flow no longer crashes thread.
- Errors now surface clearly as state messages.

## 6. SLAM Config Compatibility Fixes

### Problem

- Running slam_toolbox parameters did not include some keys present in YAML.

### Actions taken

- Compared ros2 param list /slam_toolbox to config file.
- Removed unsupported/ignored keys from slam_handheld.yaml.
- Switched to map_update_interval (supported in running version).

## 7. TF and SLAM Data Path Root Cause (Critical)

### Problem

- slam_toolbox logs showed dropped laser messages:
  - queue full
  - timestamp earlier than transform cache
- tf2_echo odom base_link failed (odom frame missing in TF tree during SLAM mode).

### Root cause

- In SLAM launch path, odom->base_link TF publisher chain was incomplete.
- diff_drive_controller published /odom messages, but not TF transform.
- Nav2 launch had EKF TF publisher; SLAM launch did not.

### Fix applied

- Updated handheld_slam.launch.py to include:
  - static TF base_link->base_footprint
  - static TF base_link->imu_link
  - robot_localization ekf_node with ekf.yaml
- Tuned slam_handheld.yaml to reduce scan backlog and TF timing pressure:
  - throttle_scans
  - scan_queue_size
  - tf_buffer_duration
  - transform_timeout

### Outcome

- Map generation and save became functional.

## 8. Map Switch / Stale Map Issue (Resolved)

### Symptom observed

- After reopening site and loading one saved map, switching to another map could keep stale map visuals.
- rosbridge logs showed repeated service errors:
  - call_service InvalidServiceException: Service /map_server/map does not exist
- During map switch, old LiDAR/path visuals could remain temporarily.

### Root cause

- UI map switch flow depended on /map_server/map service retries while nav2/map_server might not exist yet.
- Service failures were noisy and could leave stale visuals.

### Fixes applied (index.html)

- Switched map-switch completion to /map topic (instead of /map_server/map service).
- Added guarded map-switch state:
  - mapLoadRequestToken
  - mapSwitchInProgress
  - mapSwitchTargetName
- Clear stale visuals immediately when switching map:
  - occupancyData / occupancyCachedCanvas
  - lidarPoints
  - globalPath
- Added timeout feedback if no /map arrives after map load command.
- Suppressed scan redraws during active map switch to avoid stale LiDAR overlays.

### Outcome

- Switching maps now waits for live /map update and applies the new map cleanly.
- Removed /map_server/map service-call spam and related rosbridge errors.
- Old map/overlay artifacts during switch are significantly reduced.

## 9. Key Files Touched

- e:/Warehouse/index.html
- e:/Warehouse/server.py
- e:/Warehouse/Turtlebot3PI-master/src/agv_controller/agv_controller/slam_manager_node.py
- e:/Warehouse/Turtlebot3PI-master/src/agv_controller/config/slam_handheld.yaml
- e:/Warehouse/Turtlebot3PI-master/src/agv_controller/launch/handheld_slam.launch.py
- e:/Warehouse/CHAT_HANDOFF_SUMMARY.md

## 10. Practical Verification Commands (Pi)

- ros2 topic echo /slam/command
- ros2 topic echo /slam/map_list --once
- ros2 topic echo /map --once
- ros2 topic hz /scan
- ros2 run tf2_ros tf2_echo odom base_link
- ros2 run tf2_ros tf2_echo base_link laser

## 11. Short Status

- Command transport: working
- Map list publish/subscribe: working
- Teleop command relay: working
- SLAM map save: fixed and diagnosable
- TF chain in SLAM mode: fixed
- Map switching across saved maps: fixed to /map-topic-driven flow
- Initial pose UI fixed: `/initialpose` no longer forces local robot pose update; map display follows `/amcl_pose`

## 12. Current Focus

- Monitor real hardware behavior while navigating after map switch.
- Optional next cleanup: address rosbridge /cmd_vel QoS warning spam (separate from map switching).
