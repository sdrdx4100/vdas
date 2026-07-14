"""動作確認用の車両走行データ (CSV) を生成する。

使い方:  python scripts/generate_sample_data.py [出力パス] [行数]
"""
import csv
import math
import random
import sys
from datetime import datetime, timedelta


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else "sample_drive.csv"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 60000  # 10ms周期で10分相当

    random.seed(42)
    t0 = datetime(2026, 7, 1, 9, 0, 0)
    speed = 0.0
    modes = ["ECO", "NORMAL", "SPORT"]
    mode = "NORMAL"

    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["timestamp", "elapsed_s", "vehicle_speed_kmh", "engine_rpm",
                    "throttle_pct", "brake_pct", "coolant_temp_c", "battery_v",
                    "gear", "steering_deg", "accel_x_g", "accel_y_g", "drive_mode"])
        for i in range(n):
            t = i * 0.01
            # 加減速を繰り返す速度プロファイル
            target = 60 + 40 * math.sin(t / 45) + 15 * math.sin(t / 7)
            target = max(0, target)
            speed += (target - speed) * 0.002 + random.gauss(0, 0.05)
            speed = max(0.0, speed)
            throttle = max(0.0, min(100.0, (target - speed) * 8 + random.gauss(20, 5)))
            brake = max(0.0, min(100.0, (speed - target) * 6 + random.gauss(0, 2))) if speed > target else 0.0
            gear = min(6, max(1, int(speed // 20) + 1))
            rpm = 800 + speed * 55 / gear * 1.9 + throttle * 8 + random.gauss(0, 30)
            coolant = 70 + 20 * (1 - math.exp(-t / 180)) + random.gauss(0, 0.3)
            battery = 13.8 + random.gauss(0, 0.05) - (0.3 if throttle > 80 else 0)
            steering = 25 * math.sin(t / 12) + random.gauss(0, 1.5)
            accel_x = (target - speed) * 0.01 + random.gauss(0, 0.02)
            accel_y = -steering * 0.004 * (speed / 100) + random.gauss(0, 0.01)
            if i % 6000 == 0:
                mode = random.choice(modes)
            w.writerow([
                (t0 + timedelta(seconds=t)).isoformat(sep=" ", timespec="milliseconds"),
                round(t, 2), round(speed, 2), round(rpm, 1), round(throttle, 1),
                round(brake, 1), round(coolant, 2), round(battery, 3), gear,
                round(steering, 2), round(accel_x, 4), round(accel_y, 4), mode,
            ])
    print(f"generated: {out} ({n} rows)")


if __name__ == "__main__":
    main()
