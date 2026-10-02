// The robot in focus, redrawn fork-up at a fixed size for the spec sheet:
// its lidar returns, the fork's reach and load, the battery and the
// safety field.

import { SPEC } from "../sim/robot.js";
import { FORK } from "../sim/collide.js";
import { status } from "./robot.js";

const NS = "http://www.w3.org/2000/svg";
// ranges on a square-root scale, or a wall six meters off would run far
// off the tile while one at half a meter hid under the body
const RAY_SCALE = 62;

export class Anatomy {
  constructor(root) {
    this.root = root;
    this.layer = root.querySelector("[data-rays]");
    this.forks = root.querySelector("[data-forks]");
    this.load = root.querySelector("[data-load]");
    this.battery = root.querySelector("[data-battery]");
    this.leds = [...root.querySelectorAll("[data-leds]")];
    this.beacon = root.querySelector("[data-beacon]");
    this.plate = root.querySelector("[data-plate]");
    this.field = root.querySelector("[data-field]");
    this.reach = 0;
    this.rays = [];
    for (let k = 0; k < SPEC.lidarRays; k++) {
      const line = document.createElementNS(NS, "line");
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("r", "1.6");
      this.layer.append(line, dot);
      this.rays.push({ line, dot });
    }
  }

  update(robot, ease = 1) {
    if (!robot) return;
    const n = SPEC.lidarRays;
    for (let k = 0; k < n; k++) {
      // drawn nose-up: the middle ray points to the top of the tile
      const a = -Math.PI / 2 - SPEC.lidarFov / 2 + (SPEC.lidarFov * k) / (n - 1);
      const d = robot.lidar[k];
      const len = Math.sqrt(d) * RAY_SCALE;
      const x = (Math.cos(a) * len).toFixed(1);
      const y = (Math.sin(a) * len).toFixed(1);
      const { line, dot } = this.rays[k];
      line.setAttribute("x2", x);
      line.setAttribute("y2", y);
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", y);
      dot.style.opacity = d < SPEC.lidarRange - 0.01 ? "1" : "0";
    }
    this.reach += (robot.fork.reach - this.reach) * ease;
    // one SVG unit is a centimeter
    const out = this.reach * FORK.reach * 100;
    this.forks.setAttribute("transform", `translate(0 ${(-out).toFixed(2)})`);
    const lift = Math.max(0, robot.fork.height - SPEC.travelHeight) / SPEC.maxFork;
    this.load.style.opacity = robot.load ? "1" : "0";
    this.load.setAttribute("transform", `translate(30 ${(48 - out).toFixed(2)}) scale(${(1 + lift * 0.14).toFixed(3)})`);
    this.battery.setAttribute("width", (Math.max(0, robot.battery) * 14.8).toFixed(2));
    this.battery.style.fill = robot.battery < SPEC.battery.low ? "#ef4444" : "#16a34a";
    const color = status(robot);
    for (const led of this.leds) led.style.fill = color;
    const moving = Math.abs(robot.v) > 0.05 || Math.abs(robot.w) > 0.05 || !!robot.waiting;
    this.beacon.style.opacity = moving ? "1" : ".45";
    this.plate.textContent = `R${robot.id + 1}`;
    this.field.dataset.state = robot.safety;
  }
}
