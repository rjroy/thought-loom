"use client";

import { useId, useLayoutEffect, useRef } from "react";
import type { BrowseMapController, BrowseMapState } from "../features/browse/map-controller";
import { browseMapGeometry as geometry, fitMapCamera, type MapCamera } from "../features/browse/map-layout";
import type { NeighborhoodEdge } from "../features/browse/results";
import type { IdeaThought } from "../features/idea/types";
import type { BrowseMapMemory } from "./browse-provider";
import styles from "./browse-map.module.css";

const color = (edge: NeighborhoodEdge) => edge.kind === "connection" && edge.connection.rejected === true ? "var(--brand-color-9)"
  : edge.kind === "evolution" ? "var(--color-link)" : edge.kind === "provenance" ? "var(--brand-color-12)" : "var(--color-body)";
const panKeys: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48],
};

export function BrowseMapSurface({ state, controller, memory, titleOf }: {
  state: BrowseMapState; controller: BrowseMapController; memory: BrowseMapMemory; titleOf: (thought: IdeaThought) => string;
}) {
  const region = useRef<HTMLDivElement>(null);
  const pan = useRef<{ pointer: number; x: number; y: number; camera: MapCamera } | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const instructions = `${uid}-instructions`;
  function fit() {
    const viewport = region.current;
    if (!viewport || !viewport.clientWidth || !viewport.clientHeight) return;
    controller.setCamera(fitMapCamera(controller.getSnapshot().positions, geometry,
      { width: viewport.clientWidth, height: viewport.clientHeight }, { padding: 40, minScale: 0.05, maxScale: 1 }));
  }
  useLayoutEffect(() => {
    const root = state.positions[state.location.rootId];
    if (state.phase !== "ready" || !root || memory.framedRoot === root || !region.current?.clientWidth) return;
    // Frame entry once. Existing root coordinates survive expansions and mounted reader returns.
    memory.framedRoot = root;
    fit();
  }, [state.positions, state.phase, state.location.rootId, memory, controller]);
  function zoom(factor: number) {
    const camera = controller.getSnapshot().camera, viewport = region.current;
    if (!viewport) return;
    const scale = Math.max(0.05, Math.min(2, camera.scale * factor)), ratio = scale / camera.scale;
    const x = viewport.clientWidth / 2, y = viewport.clientHeight / 2;
    controller.setCamera({ scale, x: x - (x - camera.x) * ratio, y: y - (y - camera.y) * ratio });
  }
  const pairs = new Map<string, string[]>();
  for (const edge of state.edges) {
    const key = JSON.stringify([edge.fromId, edge.toId].sort());
    const ids = pairs.get(key) ?? []; ids.push(edge.id); pairs.set(key, ids);
  }
  return <div className={styles.surface}>
    <div className={styles.cameraTools}>
      <button className={styles.button} type="button" onClick={fit}>Fit map</button>
      <button className={styles.button} type="button" onClick={() => zoom(1.2)}>Zoom in</button>
      <button className={styles.button} type="button" onClick={() => zoom(1 / 1.2)}>Zoom out</button>
    </div>
    <div ref={region} className={styles.canvas} role="region" aria-label="Idea map" aria-describedby={instructions} tabIndex={0}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const delta = panKeys[event.key];
        if (!delta) return;
        event.preventDefault();
        const camera = controller.getSnapshot().camera;
        controller.setCamera({ ...camera, x: camera.x + (delta[0] ?? 0), y: camera.y + (delta[1] ?? 0) });
      }}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest("button,a,input")) return;
        pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, camera: controller.getSnapshot().camera };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const start = pan.current;
        if (start?.pointer === event.pointerId) controller.setCamera({ ...start.camera,
          x: start.camera.x + event.clientX - start.x, y: start.camera.y + event.clientY - start.y });
      }}
      onPointerUp={() => { pan.current = null; }} onPointerCancel={() => { pan.current = null; }} onLostPointerCapture={() => { pan.current = null; }}>
      <div className={styles.world} style={{ transform: `translate(${state.camera.x}px, ${state.camera.y}px) scale(${state.camera.scale})` }}>
        <svg className={styles.edges} width="1" height="1" aria-hidden="true">
          <defs>{(["evolution", "provenance", "connection", "rejected"] as const).map(kind => <marker key={kind} id={`${uid}-${kind}`}
            markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0 8 4 0 8Z" fill={kind === "evolution" ? "var(--color-link)" : kind === "provenance" ? "var(--brand-color-12)" : kind === "rejected" ? "var(--brand-color-9)" : "var(--color-body)"} />
          </marker>)}</defs>
          {state.edges.map(edge => {
            const from = state.positions[edge.fromId], to = state.positions[edge.toId];
            if (!from || !to) return null;
            const endpoints = [edge.fromId, edge.toId].sort();
            const pair = pairs.get(JSON.stringify(endpoints)) ?? [edge.id];
            const offset = Math.max(-80, Math.min(80, (pair.indexOf(edge.id) - (pair.length - 1) / 2) * 24));
            const ax = from.x + geometry.nodeWidth / 2, ay = from.y + geometry.nodeHeight / 2;
            const bx = to.x + geometry.nodeWidth / 2, by = to.y + geometry.nodeHeight / 2;
            const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy) || 1;
            const self = edge.fromId === edge.toId;
            // Parallel lanes use one pair orientation; reversing an arrow must not reverse its lane too.
            const orientation = edge.fromId === endpoints[0] ? 1 : -1;
            const cx = (ax + bx) / 2 - dy / length * offset * orientation, cy = (ay + by) / 2 + dx / length * offset * orientation;
            const trim = (x: number, y: number) => 1 / Math.max(Math.abs(x) / (geometry.nodeWidth / 2 + 4), Math.abs(y) / (geometry.nodeHeight / 2 + 4), 0.001);
            const start = trim(cx - ax, cy - ay), end = trim(cx - bx, cy - by);
            const path = self ? `M${from.x + geometry.nodeWidth * 0.6} ${from.y} C${from.x + geometry.nodeWidth + 32} ${from.y - 32},${from.x + geometry.nodeWidth + 32} ${from.y + geometry.nodeHeight * 0.5},${from.x + geometry.nodeWidth} ${from.y + geometry.nodeHeight * 0.55}`
              : `M${ax + (cx - ax) * start} ${ay + (cy - ay) * start} Q${cx} ${cy} ${bx + (cx - bx) * end} ${by + (cy - by) * end}`;
            const rejected = edge.kind === "connection" && edge.connection.rejected === true;
            return <g key={edge.id}>
              <path d={path} fill="none" stroke={color(edge)} strokeWidth="2" strokeDasharray={edge.kind === "evolution" ? undefined : edge.kind === "provenance" ? "1 7" : "7 6"}
                strokeLinecap={edge.kind === "provenance" ? "round" : undefined} markerEnd={`url(#${uid}-${rejected ? "rejected" : edge.kind})`} />
            </g>;
          })}
        </svg>
        {state.nodes.map(node => {
          const point = state.positions[node.id];
          return point && <button key={node.id} type="button" className={`${styles.node} ${node.id === state.location.rootId ? styles.startingNode : ""} ${node.rejected === true ? styles.rejectedNode : ""}`}
            style={{ left: point.x, top: point.y, width: geometry.nodeWidth, height: geometry.nodeHeight }}
            aria-label={`Inspect ${titleOf(node)}`} aria-pressed={state.selectedId === node.id} onClick={() => controller.select(node.id)}>
            <span className={styles.nodeMeta}>{node.rejected === true ? "Rejected" : node.id === state.location.rootId ? "Starting idea" : node.author === "ai" ? "AI" : node.author === "user" ? "You" : "Imported source"}</span>
            <span className={styles.nodeTitle}>{titleOf(node)}</span>
          </button>;
        })}
      </div>
    </div>
    <p id={instructions} className={styles.instructions}>Use arrow keys to move the map. Select a thought to read it.</p>
    <ul className={styles.legend} aria-label="Relationship legend">
      <li><span className={styles.evolutionLine} aria-hidden="true" />Evolution</li>
      <li><span className={styles.connectionLine} aria-hidden="true" />Conceptual connection</li>
      <li><span className={styles.provenanceLine} aria-hidden="true" />Used as a source</li>
    </ul>
  </div>;
}
