import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDuration, type RecordingSnapshot, type RecordingState } from '@/lib/recording';
import { MicToggleCard } from './components/MicToggleCard';

// Types

type CommandResponse = {
  ok?: boolean;
  error?: string;
  snapshot?: RecordingSnapshot;
} | null;

// Constants

const EMPTY_SNAPSHOT: RecordingSnapshot = {
  state: 'idle',
  sessionId: null,
  recordingStartTime: null,
  elapsedSeconds: 0,
  chunkCount: 0,
  processingProgress: null,
  errorMessage: null,
  micWarningMessage: null,
  storageWarningMessage: null,
  canDownload: false,
  outputFileName: null,
  validation: null,
  processingMetrics: null,
  orphanedSessions: [],
  recoverySessionId: null,
  recoveryChunks: [],
  audioPreflight: {
    micChecked: false,
    micOk: false,
    micLevel: null,
    micError: null,
    systemAudioStatus: 'idle',
    systemAudioLevel: null,
    systemAudioMessage: null,
    needsSystemAudioDecision: false,
  },
};

const STARTABLE_STATES: RecordingState[] = [
  'idle',
  'done',
  'preflight_error',
  'recovery',
  'error',
];

// CSS (injected once)

const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');

  :root {
    --rk-bg: #0c0c0e;
    --rk-bg2: #141416;
    --rk-bg3: #1c1c20;
    --rk-bg4: #242428;
    --rk-b: rgba(255,255,255,0.07);
    --rk-b2: rgba(255,255,255,0.12);
    --rk-b3: rgba(255,255,255,0.18);
    --rk-t: #f0f0f2;
    --rk-t2: #8a8a96;
    --rk-t3: #55555f;
    --rk-red: #ff3b30;
    --rk-red2: #ff6058;
    --rk-reda: rgba(255,59,48,0.12);
    --rk-grn: #30d158;
    --rk-grna: rgba(48,209,88,0.1);
    --rk-amb: #ffd60a;
    --rk-amba: rgba(255,214,10,0.1);
    --rk-r: 12px;
    --rk-r2: 8px;
  }

  .rk-root {
    font-family: 'Syne', system-ui, sans-serif;
    background: var(--rk-bg);
    color: var(--rk-t);
    width: 320px;
    min-height: 320px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .rk-header {
    padding: 10px 14px;
    background: var(--rk-bg2);
    border-bottom: 1px solid var(--rk-b);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  .rk-header-left { display: flex; align-items: center; gap: 7px; }
  .rk-header-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: rgba(255,255,255,0.15);
    transition: background 0.3s, box-shadow 0.3s;
  }
  .rk-header-dot.recording {
    background: var(--rk-red);
    box-shadow: 0 0 6px rgba(255,59,48,0.5);
    animation: rk-dot-pulse 1.2s ease-in-out infinite;
  }
  .rk-header-dot.processing { background: var(--rk-amb); }
  .rk-header-dot.done { background: var(--rk-grn); }
  @keyframes rk-dot-pulse {
    0%,100% { opacity: 1; } 50% { opacity: 0.6; }
  }
  .rk-header-name { font-size: 13px; font-weight: 700; color: var(--rk-t); letter-spacing: -0.01em; }
  .rk-header-right { display: flex; align-items: center; gap: 5px; }

  .rk-badge {
    font-size: 9px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; padding: 2px 7px; border-radius: 10px;
  }
  .rk-badge-rec {
    background: var(--rk-reda); color: var(--rk-red2);
    animation: rk-badge-pulse 1.2s ease-in-out infinite;
  }
  .rk-badge-proc { background: var(--rk-amba); color: var(--rk-amb); }
  .rk-badge-done { background: var(--rk-grna); color: var(--rk-grn); }
  @keyframes rk-badge-pulse { 0%,100%{opacity:1} 50%{opacity:0.55} }

  .rk-icon-btn {
    width: 24px; height: 24px; border-radius: 6px;
    border: 1px solid var(--rk-b2); background: transparent;
    display: flex; align-items: center; justify-content: center; cursor: pointer;
    transition: background 0.15s;
  }
  .rk-icon-btn:hover { background: var(--rk-bg3); }
  .rk-icon-btn svg { width: 12px; height: 12px; stroke: var(--rk-t2); }

  .rk-body { padding: 14px; flex: 1; }
  .rk-body-sm { padding: 12px 14px; flex: 1; }

  .rk-footer {
    padding: 8px 14px 10px;
    border-top: 1px solid var(--rk-b);
    display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0;
  }
  .rk-footer-lbl { font-size: 10px; color: var(--rk-t3); }
  .rk-footer-local { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--rk-t3); }
  .rk-footer-local svg { width: 10px; height: 10px; stroke: var(--rk-t3); }

  .rk-btn-record {
    width: 100%; height: 46px; border-radius: var(--rk-r);
    border: none; background: var(--rk-red); color: white;
    font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700;
    cursor: pointer; letter-spacing: -0.01em;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    transition: box-shadow 0.15s, transform 0.1s;
  }
  .rk-btn-record:hover { box-shadow: 0 6px 20px rgba(255,59,48,0.3); transform: translateY(-1px); }
  .rk-btn-record:active { transform: translateY(0); }
  .rk-btn-record:disabled { opacity: 0.4; pointer-events: none; }

  .rk-btn-stop {
    width: 100%; height: 44px; border-radius: var(--rk-r);
    border: 1.5px solid rgba(255,59,48,0.35); background: var(--rk-reda);
    color: var(--rk-red2); font-family: 'Syne', sans-serif;
    font-size: 12px; font-weight: 700; cursor: pointer; letter-spacing: -0.01em;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    transition: all 0.15s;
  }
  .rk-btn-stop:hover { background: rgba(255,59,48,0.18); border-color: var(--rk-red); }
  .rk-btn-stop:disabled { opacity: 0.4; pointer-events: none; }

  .rk-btn-download {
    width: 100%; height: 46px; border-radius: var(--rk-r);
    border: none; background: var(--rk-grn); color: #0c0c0e;
    font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700;
    cursor: pointer; letter-spacing: -0.01em;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    margin-bottom: 6px; transition: box-shadow 0.15s;
  }
  .rk-btn-download:hover { box-shadow: 0 5px 16px rgba(48,209,88,0.25); }
  .rk-btn-download svg { width: 14px; height: 14px; stroke: #0c0c0e; }

  .rk-btn-primary {
    width: 100%; height: 44px; border-radius: 10px;
    border: none; background: var(--rk-red); color: white;
    font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700;
    cursor: pointer; margin-top: 12px; transition: box-shadow 0.15s;
  }
  .rk-btn-primary:hover { box-shadow: 0 5px 16px rgba(255,59,48,0.28); }

  .rk-btn-secondary {
    width: 100%; height: 38px; border-radius: 8px;
    border: 1px solid var(--rk-b2); background: transparent; color: var(--rk-t2);
    font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 600;
    cursor: pointer; margin-top: 6px; transition: all 0.12s;
  }
  .rk-btn-secondary:hover { background: var(--rk-bg2); color: var(--rk-t); }

  .rk-row-btns { display: flex; gap: 5px; }
  .rk-sm-btn {
    flex: 1; height: 34px; border-radius: 7px;
    border: 1px solid var(--rk-b2); background: transparent; color: var(--rk-t2);
    font-family: 'Syne', sans-serif; font-size: 10px; font-weight: 600;
    cursor: pointer; transition: all 0.12s;
  }
  .rk-sm-btn:hover { background: var(--rk-bg2); color: var(--rk-t); }

  .rk-toggle {
    width: 36px; height: 20px; border-radius: 10px;
    border: none; background: var(--rk-bg4); cursor: pointer;
    position: relative; transition: background 0.2s; flex-shrink: 0;
  }
  .rk-toggle::after {
    content: ''; position: absolute;
    width: 16px; height: 16px; border-radius: 50%;
    background: white; top: 2px; left: 2px; transition: left 0.2s;
  }
  .rk-toggle.on { background: var(--rk-red); }
  .rk-toggle.on::after { left: 18px; }

  .rk-idle-center {
    display: flex; flex-direction: column; align-items: center;
    gap: 10px; padding: 8px 0 4px; text-align: center;
  }
  .rk-idle-icon {
    width: 52px; height: 52px; border-radius: 14px;
    background: var(--rk-bg3); border: 1px solid var(--rk-b2);
    display: flex; align-items: center; justify-content: center; margin-bottom: 2px;
  }
  .rk-idle-title {
    font-size: 15px; font-weight: 700; color: var(--rk-t);
    letter-spacing: -0.02em; line-height: 1.3;
  }
  .rk-idle-sub {
    font-size: 11px; color: var(--rk-t3); line-height: 1.5; max-width: 200px;
  }

  .rk-pf-title { font-size: 14px; font-weight: 700; color: var(--rk-t); letter-spacing: -0.02em; margin-bottom: 4px; }
  .rk-pf-sub { font-size: 11px; color: var(--rk-t2); line-height: 1.5; margin-bottom: 14px; }
  .rk-pf-check {
    background: var(--rk-bg2); border: 1px solid var(--rk-b);
    border-radius: 10px; padding: 10px 12px;
    display: flex; align-items: center; gap: 10px; margin-bottom: 8px;
    transition: border-color 0.2s;
  }
  .rk-pf-check.ok { border-color: rgba(48,209,88,0.3); }
  .rk-pf-check.fail { border-color: rgba(255,59,48,0.3); }
  .rk-pf-check.pending { border-color: rgba(255,214,10,0.25); }
  .rk-pf-icon {
    width: 30px; height: 30px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .rk-pf-check.ok .rk-pf-icon { background: rgba(48,209,88,0.12); }
  .rk-pf-check.fail .rk-pf-icon { background: rgba(255,59,48,0.1); }
  .rk-pf-check.pending .rk-pf-icon { background: rgba(255,214,10,0.08); }
  .rk-pf-icon svg { width: 14px; height: 14px; }
  .rk-pf-name { font-size: 12px; font-weight: 600; color: var(--rk-t); margin-bottom: 2px; }
  .rk-pf-status { font-size: 10px; font-family: 'JetBrains Mono', monospace; }
  .rk-pf-check.ok .rk-pf-status { color: var(--rk-grn); }
  .rk-pf-check.fail .rk-pf-status { color: var(--rk-red2); }
  .rk-pf-check.pending .rk-pf-status { color: var(--rk-amb); }
  .rk-pf-bars { display: flex; align-items: flex-end; gap: 2px; height: 16px; margin-top: 4px; }
  .rk-pf-bar { width: 2.5px; border-radius: 1px; background: var(--rk-bg4); transition: height 0.1s; }
  .rk-pf-bar.lit { background: var(--rk-grn); }

  .rk-err-box {
    background: rgba(255,59,48,0.06); border: 1px solid rgba(255,59,48,0.2);
    border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
  }
  .rk-err-title { font-size: 12px; font-weight: 700; color: var(--rk-red2); margin-bottom: 4px; }
  .rk-err-body { font-size: 11px; color: var(--rk-t2); line-height: 1.5; }
  .rk-err-action {
    font-size: 11px; font-weight: 600; color: var(--rk-red2);
    background: transparent; border: 1px solid rgba(255,59,48,0.3);
    border-radius: 6px; padding: 5px 10px; cursor: pointer;
    margin-top: 8px; font-family: 'Syne', sans-serif; transition: all 0.12s;
    display: inline-block;
  }
  .rk-err-action:hover { background: var(--rk-reda); }

  .rk-rec-indicator {
    display: flex; align-items: center; justify-content: center; gap: 6px; margin-bottom: 10px;
  }
  .rk-rec-dot {
    width: 7px; height: 7px; border-radius: 50%; background: var(--rk-red);
    animation: rk-rec-pulse 1.2s ease-in-out infinite;
  }
  @keyframes rk-rec-pulse {
    0%,100% { opacity: 1; box-shadow: 0 0 0 0 rgba(255,59,48,0.4); }
    50% { opacity: 0.7; box-shadow: 0 0 0 4px rgba(255,59,48,0); }
  }
  .rk-rec-label {
    font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--rk-red2);
  }
  .rk-timer {
    font-size: 42px; font-weight: 700; font-family: 'JetBrains Mono', monospace;
    color: var(--rk-t); letter-spacing: -0.03em; text-align: center;
    line-height: 1; margin: 8px 0 6px;
  }
  .rk-timer-sep { color: var(--rk-t3); }
  .rk-waveform {
    height: 36px; background: var(--rk-bg2); border: 1px solid var(--rk-b);
    border-radius: 8px; overflow: hidden; display: flex;
    align-items: center; justify-content: center; gap: 2px;
    padding: 0 8px; margin-bottom: 10px;
  }
  .rk-wave-bar {
    width: 2px; border-radius: 1px; background: var(--rk-red); opacity: 0.65;
    animation: rk-wave 0.4s ease-in-out infinite alternate;
  }
  @keyframes rk-wave { from { transform: scaleY(0.15); } to { transform: scaleY(1); } }

  .rk-meta-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 10px; }
  .rk-meta-card {
    background: var(--rk-bg2); border: 1px solid var(--rk-b); border-radius: 8px;
    padding: 7px 8px; text-align: center;
  }
  .rk-meta-val { font-size: 12px; font-weight: 600; color: var(--rk-t); font-family: 'JetBrains Mono', monospace; line-height: 1.2; }
  .rk-meta-lbl { font-size: 9px; color: var(--rk-t3); letter-spacing: 0.04em; text-transform: uppercase; margin-top: 2px; }

  .rk-chunks-row { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; padding: 0 2px; }
  .rk-chunks-label { font-size: 10px; color: var(--rk-t3); }
  .rk-chunk-dots { display: flex; gap: 3px; }
  .rk-chunk-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--rk-grn); }
  .rk-chunk-dot.pending { background: var(--rk-bg3); border: 1px solid var(--rk-b2); }
  .rk-safe-tag { font-size: 10px; font-weight: 600; color: var(--rk-grn); margin-left: 2px; }

  .rk-warn-box {
    background: var(--rk-amba); border: 1px solid rgba(255,214,10,0.25);
    border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
  }
  .rk-warn-title { font-size: 12px; font-weight: 700; color: var(--rk-amb); margin-bottom: 3px; }
  .rk-warn-body { font-size: 11px; color: var(--rk-t2); line-height: 1.5; margin-bottom: 8px; }
  .rk-warn-btns { display: flex; gap: 6px; }
  .rk-warn-btn-p {
    flex: 1; padding: 6px; border-radius: 7px; border: none;
    background: var(--rk-amb); color: #2a1f00;
    font-family: 'Syne', sans-serif; font-size: 10px; font-weight: 700; cursor: pointer;
  }
  .rk-warn-btn-s {
    flex: 1; padding: 6px; border-radius: 7px;
    border: 1px solid rgba(255,214,10,0.3); background: transparent;
    color: var(--rk-amb); font-family: 'Syne', sans-serif; font-size: 10px; font-weight: 600; cursor: pointer;
  }

  .rk-armed-center {
    display: flex; flex-direction: column; align-items: center;
    padding: 16px 0 12px; gap: 10px;
  }
  .rk-armed-icon {
    width: 52px; height: 52px; border-radius: 14px;
    background: var(--rk-bg3); border: 1px solid var(--rk-b2);
    display: flex; align-items: center; justify-content: center;
  }
  .rk-armed-icon svg { width: 22px; height: 22px; stroke: rgba(255,255,255,0.4); }
  .rk-armed-title { font-size: 14px; font-weight: 700; color: var(--rk-t); text-align: center; letter-spacing: -0.02em; }
  .rk-armed-sub { font-size: 11px; color: var(--rk-t3); text-align: center; line-height: 1.5; max-width: 200px; }
  .rk-armed-indicator {
    background: var(--rk-bg2); border: 1px solid var(--rk-b); border-radius: 8px;
    padding: 8px 14px; display: flex; align-items: center; gap: 6px;
  }
  .rk-armed-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--rk-amb); animation: rk-badge-pulse 1.2s ease-in-out infinite; }

  .rk-proc-center { display: flex; flex-direction: column; align-items: center; padding: 8px 0 4px; }
  .rk-proc-ring-wrap {
    width: 52px; height: 52px; border-radius: 14px;
    background: var(--rk-bg2); border: 1px solid var(--rk-b);
    display: flex; align-items: center; justify-content: center;
    position: relative; margin-bottom: 12px;
  }
  .rk-proc-ring {
    position: absolute; inset: -4px; border-radius: 18px;
    border: 2px solid transparent; border-top-color: var(--rk-red);
    animation: rk-spin 1s linear infinite;
  }
  @keyframes rk-spin { to { transform: rotate(360deg); } }
  .rk-proc-ring-wrap svg { width: 22px; height: 22px; }
  .rk-proc-title { font-size: 14px; font-weight: 700; color: var(--rk-t); letter-spacing: -0.02em; text-align: center; margin-bottom: 4px; }
  .rk-proc-sub { font-size: 11px; color: var(--rk-t2); text-align: center; line-height: 1.5; margin-bottom: 16px; max-width: 210px; }
  .rk-prog-track { width: 100%; height: 3px; background: var(--rk-bg3); border-radius: 2px; overflow: hidden; margin-bottom: 6px; }
  .rk-prog-fill { height: 100%; background: var(--rk-red); border-radius: 2px; transition: width 0.3s; }
  .rk-prog-row { display: flex; justify-content: space-between; margin-bottom: 14px; }
  .rk-prog-pct { font-size: 10px; font-family: 'JetBrains Mono', monospace; color: var(--rk-t2); }
  .rk-prog-eta { font-size: 10px; color: var(--rk-t3); }
  .rk-priv-note {
    display: flex; align-items: center; gap: 6px;
    background: var(--rk-bg2); border: 1px solid var(--rk-b);
    border-radius: 7px; padding: 7px 10px; width: 100%;
  }
  .rk-priv-note svg { width: 11px; height: 11px; stroke: var(--rk-t3); flex-shrink: 0; }
  .rk-priv-note span { font-size: 10px; color: var(--rk-t3); line-height: 1.4; }

  .rk-done-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .rk-done-icon {
    width: 32px; height: 32px; border-radius: 8px;
    background: var(--rk-grna); border: 1px solid rgba(48,209,88,0.25);
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .rk-done-icon svg { width: 14px; height: 14px; stroke: var(--rk-grn); }
  .rk-done-title { font-size: 14px; font-weight: 700; color: var(--rk-t); letter-spacing: -0.01em; }
  .rk-done-sub { font-size: 11px; color: var(--rk-t3); margin-top: 1px; }
  .rk-done-preview { background: var(--rk-bg2); border: 1px solid var(--rk-b); border-radius: 10px; overflow: hidden; margin-bottom: 10px; }
  .rk-done-thumb { height: 96px; background: var(--rk-bg3); display: flex; align-items: center; justify-content: center; position: relative; }
  .rk-done-thumb svg { width: 32px; height: 32px; }
  .rk-done-dur {
    position: absolute; bottom: 6px; right: 8px;
    background: rgba(0,0,0,0.7); border-radius: 4px; padding: 2px 6px;
    font-size: 10px; font-family: 'JetBrains Mono', monospace; color: white;
  }
  .rk-done-meta { display: grid; grid-template-columns: repeat(4,1fr); padding: 9px 12px; }
  .rk-done-meta-item { text-align: center; }
  .rk-done-meta-item:not(:last-child) { border-right: 1px solid var(--rk-b); }
  .rk-done-mval { font-size: 11px; font-weight: 600; color: var(--rk-t); font-family: 'JetBrains Mono', monospace; }
  .rk-done-mlbl { font-size: 9px; color: var(--rk-t3); text-transform: uppercase; letter-spacing: 0.04em; margin-top: 1px; }
  .rk-val-row {
    display: flex; align-items: center; gap: 6px;
    background: var(--rk-grna); border: 1px solid rgba(48,209,88,0.2);
    border-radius: 8px; padding: 7px 10px; margin-bottom: 10px;
  }
  .rk-val-row svg { width: 12px; height: 12px; stroke: var(--rk-grn); flex-shrink: 0; }
  .rk-val-row span { font-size: 10px; font-weight: 600; color: var(--rk-grn); }

  .rk-recovery-box {
    background: var(--rk-bg2); border: 1px solid rgba(255,59,48,0.25);
    border-radius: 10px; padding: 12px; margin-bottom: 10px;
  }
  .rk-recovery-title { font-size: 12px; font-weight: 700; color: var(--rk-red2); margin-bottom: 3px; }
  .rk-recovery-sub { font-size: 11px; color: var(--rk-t2); margin-bottom: 10px; line-height: 1.5; }
  .rk-chunk-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .rk-chunk-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; background: var(--rk-bg3); border-radius: 6px; }
  .rk-chunk-cb { width: 14px; height: 14px; accent-color: var(--rk-red); cursor: pointer; flex-shrink: 0; }
  .rk-chunk-name { font-size: 11px; font-family: 'JetBrains Mono', monospace; color: var(--rk-t); flex: 1; }
  .rk-chunk-status { font-size: 9px; font-weight: 600; letter-spacing: 0.04em; padding: 2px 6px; border-radius: 4px; }
  .rk-chunk-status.ok { background: var(--rk-grna); color: var(--rk-grn); }
  .rk-chunk-status.suspect { background: var(--rk-amba); color: var(--rk-amb); }
  .rk-chunk-status.missing { background: rgba(255,59,48,0.1); color: var(--rk-red2); }
  .rk-recovery-actions { display: flex; gap: 5px; }
  .rk-session-id { font-size: 10px; color: var(--rk-t3); text-align: center; margin-top: 8px; font-family: 'JetBrains Mono', monospace; }

  .rk-orphan-card {
    background: var(--rk-amba); border: 1px solid rgba(255,214,10,0.2);
    border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
  }
  .rk-orphan-title { font-size: 12px; font-weight: 700; color: var(--rk-amb); margin-bottom: 3px; }
  .rk-orphan-meta { font-size: 10px; color: rgba(255,214,10,0.7); font-family: 'JetBrains Mono', monospace; margin-bottom: 8px; }
  .rk-orphan-btns { display: flex; gap: 5px; }
  .rk-orphan-p {
    flex: 2; padding: 6px; border-radius: 7px; border: none;
    background: var(--rk-amb); color: #2a1f00;
    font-family: 'Syne', sans-serif; font-size: 10px; font-weight: 700; cursor: pointer;
  }
  .rk-orphan-s {
    flex: 1; padding: 6px; border-radius: 7px;
    border: 1px solid rgba(255,214,10,0.3); background: transparent;
    color: rgba(255,214,10,0.7); font-family: 'Syne', sans-serif; font-size: 10px; font-weight: 600; cursor: pointer;
  }

  .rk-storage-warn {
    display: flex; align-items: center; gap: 6px;
    background: var(--rk-amba); border: 1px solid rgba(255,214,10,0.2);
    border-radius: 7px; padding: 6px 10px; margin-bottom: 8px;
  }
  .rk-storage-warn svg { width: 11px; height: 11px; stroke: var(--rk-amb); flex-shrink: 0; }
  .rk-storage-warn span { font-size: 10px; color: var(--rk-amb); font-weight: 500; }

  .rk-divider { border-top: 1px solid var(--rk-b); padding-top: 12px; margin-top: 2px; }
  .rk-divider-label { font-size: 12px; font-weight: 600; color: var(--rk-t); margin-bottom: 12px; }
`;

function useGlobalStyles() {
  useEffect(() => {
    const id = 'rk-styles';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = STYLES;
    document.head.appendChild(el);
  }, []);
}

function LockIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none" strokeWidth="1.4" strokeLinecap="round">
      <rect x="2" y="5" width="8" height="6" rx="1" />
      <path d="M4 5V3.5a2 2 0 114 0V5" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.3 3.3l.85.85M11.8 11.8l.85.85M3.3 12.7l.85-.85M11.8 4.2l.85-.85" />
    </svg>
  );
}

function RecDot() {
  return <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'white', flexShrink: 0 }} />;
}

function StopSquare() {
  return <div style={{ width: 9, height: 9, background: 'var(--rk-red)', borderRadius: 2, flexShrink: 0 }} />;
}

function MicLevelBars({ level }: { level: number | null }) {
  const heights = [10, 16, 8, 20, 14, 22, 6, 18, 12, 24, 8, 16];
  const litCount = level === null ? 0 : Math.max(1, Math.min(12, Math.round((level / 30) * 12)));
  return (
    <div className="rk-pf-bars">
      {heights.map((h, i) => (
        <div key={i} className={`rk-pf-bar${i < litCount ? ' lit' : ''}`} style={{ height: h }} />
      ))}
    </div>
  );
}

function Waveform() {
  const bars = Array.from({ length: 52 }, (_, i) => {
    const h = 4 + ((i * 7 + 13) % 27);
    const delay = (i * 0.023) % 0.5;
    const dur = 0.35 + (i * 0.013) % 0.35;
    return (
      <div
        key={i}
        className="rk-wave-bar"
        style={{ height: h, animationDelay: `${delay}s`, animationDuration: `${dur}s` }}
      />
    );
  });
  return <div className="rk-waveform">{bars}</div>;
}

function Timer({ seconds }: { seconds: number }) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return (
      <div className="rk-timer">
        {h}
        <span className="rk-timer-sep">:</span>
        {String(m).padStart(2, '0')}
        <span className="rk-timer-sep">:</span>
        {String(s).padStart(2, '0')}
      </div>
    );
  }
  return (
    <div className="rk-timer">
      {m}
      <span className="rk-timer-sep">:</span>
      {String(s).padStart(2, '0')}
    </div>
  );
}

function ChunkDots({ count, safeCount }: { count: number; safeCount: number }) {
  const maxDots = 8;
  const display = Math.min(count + 1, maxDots);
  return (
    <div className="rk-chunk-dots">
      {Array.from({ length: display }, (_, i) => (
        <div key={i} className={`rk-chunk-dot${i >= safeCount ? ' pending' : ''}`} />
      ))}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatOrphanTime(ms: number): string {
  if (!ms) return 'Unknown';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Header({
  state,
  onSettings,
}: {
  state: RecordingState;
  onSettings: () => void;
}) {
  const isRecording = state === 'recording' || state === 'audio_warning' || state === 'stopping';
  const isProcessing = state === 'processing' || state === 'validating';
  const isDone = state === 'done';

  const dotClass = isRecording ? 'recording' : isProcessing ? 'processing' : isDone ? 'done' : '';

  return (
    <div className="rk-header">
      <div className="rk-header-left">
        <div className={`rk-header-dot ${dotClass}`} />
        <span className="rk-header-name">RecordKit</span>
      </div>
      <div className="rk-header-right">
        {isRecording && <span className="rk-badge rk-badge-rec">● REC</span>}
        {isProcessing && <span className="rk-badge rk-badge-proc">◐ Processing</span>}
        {isDone && <span className="rk-badge rk-badge-done">✓ Ready</span>}
        {(state === 'idle' || state === 'done' || state === 'error') && (
          <button className="rk-icon-btn" onClick={onSettings} title="Settings">
            <SettingsIcon />
          </button>
        )}
      </div>
    </div>
  );
}

function Footer({ label }: { label: string }) {
  return (
    <div className="rk-footer">
      <span className="rk-footer-lbl">{label}</span>
      <div className="rk-footer-local">
        <LockIcon />
        <span>Local only</span>
      </div>
    </div>
  );
}

function IdleScreen({
  micControl,
  onStart,
  isBusy,
  canStartRecording,
  startButtonLabel,
  orphan,
  onRecoverOrphan,
  onDiscardOrphan,
  storageWarning,
}: {
  micControl: ReactNode;
  onStart: () => void;
  isBusy: boolean;
  canStartRecording: boolean;
  startButtonLabel: string;
  orphan: RecordingSnapshot['orphanedSessions'][0] | null;
  onRecoverOrphan: (id: string) => void;
  onDiscardOrphan: (id: string) => void;
  storageWarning: string | null;
}) {
  return (
    <>
      <div className="rk-body">
        {orphan && (
          <div className="rk-orphan-card">
            <div className="rk-orphan-title">Interrupted recording found</div>
            <div className="rk-orphan-meta">
              {formatOrphanTime(orphan.startTime)} · {orphan.chunkCount} chunks ·{' '}
              {formatBytes(orphan.totalSize)}
            </div>
            <div className="rk-orphan-btns">
              <button
                className="rk-orphan-p"
                disabled={isBusy}
                onClick={() => onRecoverOrphan(orphan.sessionId)}>
                Process &amp; Download
              </button>
              <button
                className="rk-orphan-s"
                disabled={isBusy}
                onClick={() => onDiscardOrphan(orphan.sessionId)}>
                Discard
              </button>
            </div>
          </div>
        )}

        {orphan && (
          <div className="rk-divider">
            <div className="rk-divider-label">New recording</div>
          </div>
        )}

        {!orphan && (
          <div className="rk-idle-center">
            <div className="rk-idle-icon">
              <svg
                width="22"
                height="22"
                viewBox="0 0 22 22"
                fill="none"
                stroke="rgba(255,255,255,0.3)"
                strokeWidth="1.4"
                strokeLinecap="round">
                <circle cx="11" cy="11" r="7.5" />
                <line x1="11" y1="6" x2="11" y2="11" />
                <line x1="11" y1="11" x2="14.5" y2="11" />
                <circle cx="11" cy="11" r="1.2" fill="rgba(255,255,255,0.3)" stroke="none" />
              </svg>
            </div>
            <div className="rk-idle-title">
              Record anything.
              <br />
              Lose nothing.
            </div>
            <div className="rk-idle-sub">
              Every recording is auto-saved in 10-second chunks. Your data never leaves your device.
            </div>
          </div>
        )}

        {storageWarning && (
          <div className="rk-storage-warn">
            <svg viewBox="0 0 12 12" fill="none" strokeWidth="1.4" strokeLinecap="round">
              <path d="M6 1L11 10H1L6 1z" />
              <line x1="6" y1="5" x2="6" y2="7.5" />
              <circle cx="6" cy="9" r="0.5" fill="var(--rk-amb)" stroke="none" />
            </svg>
            <span>{storageWarning}</span>
          </div>
        )}

        {micControl}

        <button className="rk-btn-record" disabled={isBusy || !canStartRecording} onClick={onStart}>
          <RecDot />
          {startButtonLabel}
        </button>
      </div>
      <Footer label="Ready to record" />
    </>
  );
}

function PreflightScreen({
  audioPreflight,
  includeMic,
  onConfirm,
  onBack,
  isBusy,
}: {
  audioPreflight: RecordingSnapshot['audioPreflight'];
  includeMic: boolean;
  onConfirm: () => void;
  onBack: () => void;
  isBusy: boolean;
}) {
  const micOk = includeMic ? audioPreflight.micOk : true;
  const micChecked = includeMic ? audioPreflight.micChecked : true;
  const micClass = includeMic ? (!micChecked ? 'pending' : micOk ? 'ok' : 'fail') : 'ok';
  const micStatus = includeMic
    ? !micChecked
      ? 'Checking...'
      : micOk
        ? 'Active — signal detected'
        : 'Not detected'
    : 'Disabled for this recording';

  return (
    <>
      <div className="rk-body">
        <div className="rk-pf-title">Checking audio</div>
        <div className="rk-pf-sub">
          We verify your audio before every recording so you never start silent.
        </div>

        <div className={`rk-pf-check ${micClass}`}>
          <div className="rk-pf-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke={micOk ? 'var(--rk-grn)' : 'var(--rk-red2)'}
              strokeWidth="1.5"
              strokeLinecap="round">
              <path d="M7 1.5C5 1.5 3.5 3 3.5 5v2.5C3.5 9.5 5 11 7 11s3.5-1.5 3.5-3.5V5C10.5 3 9 1.5 7 1.5z" />
              <path d="M5 12.5h4M7 11v1.5" />
            </svg>
          </div>
          <div className="rk-pf-info">
            <div className="rk-pf-name">Microphone</div>
            <div className="rk-pf-status">{micStatus}</div>
            {includeMic && micOk && <MicLevelBars level={audioPreflight.micLevel} />}
          </div>
        </div>

        <div className="rk-pf-check pending">
          <div className="rk-pf-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="var(--rk-amb)"
              strokeWidth="1.5"
              strokeLinecap="round">
              <rect x="1.5" y="3" width="11" height="8" rx="1.5" />
              <path d="M4.5 10.5v1.5M9.5 10.5v1.5M3 12h8" />
            </svg>
          </div>
          <div className="rk-pf-info">
            <div className="rk-pf-name">System audio</div>
            <div className="rk-pf-status">Verified after capture starts</div>
          </div>
        </div>

        <div style={{ fontSize: 10, color: 'var(--rk-t3)', lineHeight: 1.5, marginTop: 2 }}>
          After you click start, Chrome will open the share picker. The popup may close while you
          choose what to share.
        </div>

        <button className="rk-btn-primary" onClick={onConfirm} disabled={isBusy || (includeMic && !micOk)}>
          Start Recording →
        </button>
        <button className="rk-btn-secondary" onClick={onBack}>
          ← Back
        </button>
      </div>
      <Footer label="Audio check complete" />
    </>
  );
}

function PreflightErrorScreen({
  audioPreflight,
  includeMic,
  onRetry,
  onBack,
  onContinueWithoutMic,
  isBusy,
}: {
  audioPreflight: RecordingSnapshot['audioPreflight'];
  includeMic: boolean;
  onRetry: () => void;
  onBack: () => void;
  onContinueWithoutMic: () => void;
  isBusy: boolean;
}) {
  const { micError } = audioPreflight;

  const errorContent: Record<string, { title: string; body: string; action: string }> = {
    MIC_PERMISSION_DENIED: {
      title: 'Microphone blocked',
      body: 'Chrome has blocked microphone access for this extension. Open Chrome settings and allow microphone access, then try again.',
      action: 'Open microphone settings',
    },
    MIC_PERMISSION_PROMPT: {
      title: 'Microphone permission needed',
      body: 'We need microphone access to record audio. Grant access when Chrome prompts you.',
      action: 'Grant microphone access',
    },
    MIC_NOT_FOUND: {
      title: 'No microphone detected',
      body: 'No microphone was found. Please connect a microphone and try again.',
      action: 'Try again',
    },
    MIC_IN_USE: {
      title: 'Microphone in use',
      body: 'Your microphone is being used by another application. Close other apps using the mic, then try again.',
      action: 'Try again',
    },
  };

  const info = errorContent[micError ?? ''] ?? {
    title: 'Audio check failed',
    body: 'An unexpected error occurred during audio pre-flight. Check your microphone and try again.',
    action: 'Try again',
  };

  const handleAction = async () => {
    if (micError === 'MIC_PERMISSION_DENIED') {
      void chrome.runtime.sendMessage({ type: 'OPEN_MIC_SETTINGS' });
    } else if (micError === 'MIC_PERMISSION_PROMPT') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        onRetry();
      } catch {
        // permission still denied
      }
    } else {
      onRetry();
    }
  };

  return (
    <>
      <div className="rk-body">
        <div className="rk-pf-title">{info.title}</div>
        <div className="rk-pf-sub" style={{ marginBottom: 12 }}>
          Action required before recording.
        </div>

        <div className="rk-err-box">
          <div className="rk-err-title">{micError ?? 'MIC_ERROR'}</div>
          <div className="rk-err-body">{info.body}</div>
          <button className="rk-err-action" onClick={handleAction} disabled={isBusy}>
            {info.action}
          </button>
        </div>

        <div className="rk-pf-check fail">
          <div className="rk-pf-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="var(--rk-red2)"
              strokeWidth="1.5"
              strokeLinecap="round">
              <path d="M7 1.5C5 1.5 3.5 3 3.5 5v2.5C3.5 9.5 5 11 7 11s3.5-1.5 3.5-3.5V5C10.5 3 9 1.5 7 1.5z" />
              <path d="M5 12.5h4M7 11v1.5" />
            </svg>
          </div>
          <div className="rk-pf-info">
            <div className="rk-pf-name">Microphone</div>
            <div className="rk-pf-status">
              {micError === 'MIC_PERMISSION_DENIED'
                ? 'Permission denied by Chrome'
                : micError === 'MIC_NOT_FOUND'
                  ? 'Device not found'
                  : micError === 'MIC_IN_USE'
                    ? 'In use by another app'
                    : 'Check failed'}
            </div>
          </div>
        </div>

        <button className="rk-btn-secondary" onClick={onBack}>
          ← Back
        </button>
        {includeMic && (
          <button className="rk-btn-secondary" onClick={onContinueWithoutMic} disabled={isBusy}>
            Continue without mic
          </button>
        )}
      </div>
      <Footer label="Action required" />
    </>
  );
}

function ArmedScreen({ onCancel }: { onCancel: () => void }) {
  return (
    <>
      <div className="rk-body">
        <div className="rk-armed-center">
          <div className="rk-armed-icon">
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              stroke="rgba(255,255,255,0.4)"
              strokeWidth="1.4"
              strokeLinecap="round">
              <rect x="2" y="4" width="18" height="12" rx="2" />
              <path d="M8 19h6M11 16v3" />
            </svg>
          </div>
          <div className="rk-armed-title">Choose what to record</div>
          <div className="rk-armed-sub">
            Select a tab, window, or screen from Chrome&apos;s share dialog
          </div>
          <div className="rk-armed-indicator">
            <div className="rk-armed-pulse" />
            <span style={{ fontSize: 11, color: 'var(--rk-t2)' }}>Share picker should be open now</span>
          </div>
        </div>
        <button className="rk-btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <Footer label="Waiting for share selection..." />
    </>
  );
}

function RecordingScreen({
  snapshot,
  onStop,
  isBusy,
}: {
  snapshot: RecordingSnapshot;
  onStop: () => void;
  isBusy: boolean;
}) {
  const estimatedBytes = snapshot.chunkCount * snapshot.elapsedSeconds * 140;

  return (
    <>
      <div className="rk-body-sm">
        <div className="rk-rec-indicator">
          <div className="rk-rec-dot" />
          <span className="rk-rec-label">Recording</span>
          <span
            style={{
              fontSize: 10,
              color: 'var(--rk-t3)',
              marginLeft: 'auto',
              fontFamily: "'JetBrains Mono', monospace",
            }}>
            local only
          </span>
        </div>

        {snapshot.micWarningMessage && (
          <div className="rk-storage-warn" style={{ marginBottom: 10 }}>
            <svg viewBox="0 0 12 12" fill="none" strokeWidth="1.4" strokeLinecap="round">
              <path d="M6 1L11 10H1L6 1z" />
              <line x1="6" y1="5" x2="6" y2="7.5" />
              <circle cx="6" cy="9" r="0.5" fill="var(--rk-amb)" stroke="none" />
            </svg>
            <span>{snapshot.micWarningMessage}</span>
          </div>
        )}

        <Timer seconds={snapshot.elapsedSeconds} />
        <Waveform />

        <div className="rk-meta-grid">
          <div className="rk-meta-card">
            <div className="rk-meta-val">{snapshot.chunkCount}</div>
            <div className="rk-meta-lbl">Chunks</div>
          </div>
          <div className="rk-meta-card">
            <div className="rk-meta-val">1080p</div>
            <div className="rk-meta-lbl">Quality</div>
          </div>
          <div className="rk-meta-card">
            <div className="rk-meta-val">{formatBytes(estimatedBytes)}</div>
            <div className="rk-meta-lbl">~Size</div>
          </div>
        </div>

        <div className="rk-chunks-row">
          <span className="rk-chunks-label">Auto-saved</span>
          <ChunkDots count={snapshot.chunkCount} safeCount={snapshot.chunkCount} />
          {snapshot.chunkCount > 0 && <span className="rk-safe-tag">✓ Safe</span>}
        </div>

        <button className="rk-btn-stop" disabled={isBusy} onClick={onStop}>
          <StopSquare />
          Stop Recording
        </button>
      </div>
      <Footer label={`${snapshot.chunkCount} chunk${snapshot.chunkCount !== 1 ? 's' : ''} safe`} />
    </>
  );
}

function AudioWarningScreen({
  snapshot,
  onContinueMicOnly,
  onStopRetry,
  onStop,
  isBusy,
}: {
  snapshot: RecordingSnapshot;
  onContinueMicOnly: () => void;
  onStopRetry: () => void;
  onStop: () => void;
  isBusy: boolean;
}) {
  return (
    <>
      <div className="rk-body-sm">
        <div className="rk-rec-indicator">
          <div className="rk-rec-dot" />
          <span className="rk-rec-label">Recording</span>
        </div>

        {snapshot.micWarningMessage && (
          <div className="rk-storage-warn" style={{ marginBottom: 10 }}>
            <svg viewBox="0 0 12 12" fill="none" strokeWidth="1.4" strokeLinecap="round">
              <path d="M6 1L11 10H1L6 1z" />
              <line x1="6" y1="5" x2="6" y2="7.5" />
              <circle cx="6" cy="9" r="0.5" fill="var(--rk-amb)" stroke="none" />
            </svg>
            <span>{snapshot.micWarningMessage}</span>
          </div>
        )}

        <Timer seconds={snapshot.elapsedSeconds} />

        <div className="rk-warn-box">
          <div className="rk-warn-title">System audio not detected</div>
          <div className="rk-warn-body">
            Tab audio is silent. You may have forgotten to enable audio sharing. Continue with mic only,
            or stop and retry.
          </div>
          <div className="rk-warn-btns">
            <button className="rk-warn-btn-p" disabled={isBusy} onClick={onContinueMicOnly}>
              Continue mic only
            </button>
            <button className="rk-warn-btn-s" disabled={isBusy} onClick={onStopRetry}>
              Stop and retry
            </button>
          </div>
        </div>

        <button className="rk-btn-stop" disabled={isBusy} onClick={onStop}>
          <StopSquare />
          Stop Recording
        </button>
      </div>
      <Footer label="Decision required" />
    </>
  );
}

function StoppingScreen({ snapshot }: { snapshot: RecordingSnapshot }) {
  return (
    <>
      <div className="rk-body">
        <div className="rk-proc-center">
          <div className="rk-proc-ring-wrap">
            <div className="rk-proc-ring" />
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              stroke="rgba(255,255,255,0.35)"
              strokeWidth="1.4"
              strokeLinecap="round">
              <path d="M8 8h6v6H8z" />
            </svg>
          </div>
          <div className="rk-proc-title">Finalising</div>
          <div className="rk-proc-sub">Writing final chunk to disk. Your recording is safe.</div>
          <div className="rk-priv-note">
            <LockIcon />
            <span>
              {snapshot.chunkCount} chunk{snapshot.chunkCount !== 1 ? 's' : ''} safely saved to your
              device
            </span>
          </div>
        </div>
      </div>
      <Footer label="Saving final chunk..." />
    </>
  );
}

function ProcessingScreen({
  snapshot,
  phase,
  etaSeconds,
}: {
  snapshot: RecordingSnapshot;
  phase: 'processing' | 'validating';
  etaSeconds: number | null;
}) {
  const progress = phase === 'validating' ? 100 : Math.max(0, Math.min(100, snapshot.processingProgress ?? 0));
  const title = phase === 'validating' ? 'Validating output' : 'Converting to MP4';
  const subtitle =
    phase === 'validating'
      ? 'Running final integrity checks (headers, size, duration).'
      : `Stitching ${snapshot.chunkCount} chunks and encoding to H.264.`;

  return (
    <>
      <div className="rk-body">
        <div className="rk-proc-center">
          <div className="rk-proc-ring-wrap">
            <div className="rk-proc-ring" />
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              stroke="rgba(255,255,255,0.35)"
              strokeWidth="1.4"
              strokeLinecap="round">
              <path d="M5 11l4.5 4.5L17 7" />
            </svg>
          </div>
          <div className="rk-proc-title">{title}</div>
          <div className="rk-proc-sub">
            {subtitle}
            {phase === 'processing' &&
              (etaSeconds === null
                ? ' Estimating remaining time...'
                : etaSeconds > 0
                  ? ` About ${etaSeconds}s remaining.`
                  : ' Almost done.')}
          </div>
          <div style={{ width: '100%' }}>
            <div className="rk-prog-track">
              <div className="rk-prog-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="rk-prog-row">
              <span className="rk-prog-pct">{Math.round(progress)}%</span>
              <span className="rk-prog-eta">
                {phase === 'validating'
                  ? 'Final checks...'
                  : etaSeconds === null
                    ? 'Estimating...'
                    : etaSeconds > 0
                      ? `~${etaSeconds}s remaining`
                      : 'Finishing...'}
              </span>
            </div>
          </div>
          <div className="rk-priv-note">
            <LockIcon />
            <span>
              Processing happens entirely on your device. Your recording never leaves your computer.
            </span>
          </div>
        </div>
      </div>
      <Footer label="Converting..." />
    </>
  );
}

function DoneScreen({
  snapshot,
  onDownload,
  onRecordAgain,
  isBusy,
}: {
  snapshot: RecordingSnapshot;
  onDownload: () => void;
  onRecordAgain: () => void;
  isBusy: boolean;
}) {
  const metrics = snapshot.processingMetrics;
  const durationSec = metrics ? Math.round(metrics.inputBytes / 175000) : 0;
  const durMin = Math.floor(durationSec / 60);
  const durSec = durationSec % 60;
  const durLabel =
    durationSec > 0 ? `${durMin}:${String(durSec).padStart(2, '0')}` : formatDuration(snapshot.elapsedSeconds);

  return (
    <>
      <div className="rk-body">
        <div className="rk-done-head">
          <div className="rk-done-icon">
            <svg viewBox="0 0 16 16" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8l3.5 3.5 6.5-7" />
            </svg>
          </div>
          <div>
            <div className="rk-done-title">Recording ready</div>
            <div className="rk-done-sub">Validated · H.264 MP4 · Plays everywhere</div>
          </div>
        </div>

        <div className="rk-done-preview">
          <div className="rk-done-thumb">
            <svg
              width="32"
              height="32"
              viewBox="0 0 32 32"
              fill="none"
              stroke="rgba(255,255,255,0.12)"
              strokeWidth="1.2">
              <rect x="2" y="5" width="28" height="20" rx="2" />
              <polygon
                points="13,11 13,21 22,16"
                fill="rgba(255,255,255,0.08)"
                stroke="rgba(255,255,255,0.15)"
              />
            </svg>
            <div className="rk-done-dur">{durLabel}</div>
          </div>
          <div className="rk-done-meta">
            <div className="rk-done-meta-item">
              <div className="rk-done-mval">{durLabel}</div>
              <div className="rk-done-mlbl">Duration</div>
            </div>
            <div className="rk-done-meta-item">
              <div className="rk-done-mval">{metrics ? formatBytes(metrics.outputBytes) : '—'}</div>
              <div className="rk-done-mlbl">Size</div>
            </div>
            <div className="rk-done-meta-item">
              <div className="rk-done-mval">1080p</div>
              <div className="rk-done-mlbl">Quality</div>
            </div>
            <div className="rk-done-meta-item">
              <div className="rk-done-mval">MP4</div>
              <div className="rk-done-mlbl">Format</div>
            </div>
          </div>
        </div>

        {snapshot.validation?.passed && (
          <div className="rk-val-row">
            <svg viewBox="0 0 12 12" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 6l3 3 5-5" />
            </svg>
            <span>File validated — video, audio, and duration confirmed</span>
          </div>
        )}

        <button className="rk-btn-download" disabled={isBusy} onClick={onDownload}>
          <svg viewBox="0 0 16 16" fill="none" strokeWidth="2" strokeLinecap="round">
            <path d="M8 2v9M4 8l4 4 4-4" />
            <path d="M2 14h12" />
          </svg>
          Download MP4
        </button>
        <div className="rk-row-btns">
          <button className="rk-sm-btn" onClick={onRecordAgain}>
            Record again
          </button>
          <button className="rk-sm-btn" onClick={() => navigator.clipboard.writeText(snapshot.sessionId ?? '')}>
            Copy session ID
          </button>
        </div>
      </div>
      <Footer label="MP4 ready to download" />
    </>
  );
}

function RecoveryScreen({
  snapshot,
  selectedChunks,
  onToggleChunk,
  onProcessSelected,
  onDownloadRaw,
  onClearState,
  isBusy,
}: {
  snapshot: RecordingSnapshot;
  selectedChunks: number[];
  onToggleChunk: (index: number, checked: boolean) => void;
  onProcessSelected: () => void;
  onDownloadRaw: () => void;
  onClearState: () => void;
  isBusy: boolean;
}) {
  return (
    <>
      <div className="rk-body">
        <div className="rk-recovery-box">
          <div className="rk-recovery-title">Processing failed — your data is safe</div>
          <div className="rk-recovery-sub">
            The MP4 could not be validated. Your raw recording chunks are intact on your device. Select
            which chunks to include and try again.
          </div>
          <div className="rk-chunk-list">
            {snapshot.recoveryChunks.map((chunk) => {
              const canInclude = chunk.status !== 'missing';
              const checked = selectedChunks.includes(chunk.index);
              return (
                <div key={chunk.index} className="rk-chunk-item">
                  <input
                    type="checkbox"
                    className="rk-chunk-cb"
                    disabled={!canInclude || isBusy}
                    checked={checked}
                    onChange={(e) => onToggleChunk(chunk.index, e.currentTarget.checked)}
                  />
                  <span className="rk-chunk-name">chunk-{chunk.index}.webm</span>
                  <span className={`rk-chunk-status ${chunk.status}`}>{chunk.status}</span>
                </div>
              );
            })}
          </div>
          <div className="rk-recovery-actions">
            <button
              className="rk-btn-primary"
              style={{ margin: 0, flex: 2, height: 38, fontSize: 11 }}
              disabled={isBusy}
              onClick={onProcessSelected}>
              Process selected
            </button>
            <button
              className="rk-btn-secondary"
              style={{ margin: 0, flex: 1, height: 38 }}
              disabled={isBusy}
              onClick={onDownloadRaw}>
              Download raw
            </button>
          </div>
          <button
            className="rk-btn-secondary"
            style={{ marginTop: 8, height: 34 }}
            disabled={isBusy}
            onClick={onClearState}>
            Clear state
          </button>
        </div>
        {snapshot.sessionId && <div className="rk-session-id">Session: {snapshot.sessionId}</div>}
      </div>
      <Footer label="Validation failed" />
    </>
  );
}

function ErrorScreen({
  message,
  onRetry,
  isBusy,
}: {
  message: string;
  onRetry: () => void;
  isBusy: boolean;
}) {
  return (
    <>
      <div className="rk-body">
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: '16px 0 12px',
            gap: 10,
            textAlign: 'center',
          }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              background: 'rgba(255,59,48,0.08)',
              border: '1px solid rgba(255,59,48,0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              stroke="var(--rk-red2)"
              strokeWidth="1.4"
              strokeLinecap="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="11" y1="7" x2="11" y2="12" />
              <circle cx="11" cy="14.5" r="0.8" fill="var(--rk-red2)" stroke="none" />
            </svg>
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--rk-t)', letterSpacing: '-0.02em' }}>
            Something went wrong
          </div>
          <div style={{ fontSize: 11, color: 'var(--rk-t2)', lineHeight: 1.5, maxWidth: 220 }}>{message}</div>
          <button className="rk-btn-primary" style={{ marginTop: 8 }} disabled={isBusy} onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
      <Footer label="Error" />
    </>
  );
}

export default function App() {
  useGlobalStyles();

  const [snapshot, setSnapshot] = useState<RecordingSnapshot>(EMPTY_SNAPSHOT);
  const [isBusy, setIsBusy] = useState(false);
  const [includeMic, setIncludeMic] = useState(false);
  const [micReady, setMicReady] = useState(true);
  const [selectedRecoveryChunks, setSelectedRecoveryChunks] = useState<number[]>([]);
  const [processingStartedAtMs, setProcessingStartedAtMs] = useState<number | null>(null);
  const initializedRecoverySessionRef = useRef<string | null>(null);

  useEffect(() => {
    const listener = (message: unknown) => {
      const payload = message as { type?: string; snapshot?: RecordingSnapshot };
      if (payload.type === 'STATE_CHANGE' && payload.snapshot) {
        setSnapshot(payload.snapshot);
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    void refreshState();
    void chrome.runtime.sendMessage({ type: 'REFRESH_ORPHANS' }).catch(() => {});

    const interval = window.setInterval(() => void refreshState(), 1000);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (snapshot.state !== 'recovery') {
      initializedRecoverySessionRef.current = null;
      return;
    }

    const sessionKey = snapshot.recoverySessionId ?? snapshot.sessionId;
    if (!sessionKey) return;
    if (initializedRecoverySessionRef.current === sessionKey) return;

    initializedRecoverySessionRef.current = sessionKey;
    const included = snapshot.recoveryChunks.filter((c) => c.included).map((c) => c.index);
    setSelectedRecoveryChunks(included);
  }, [snapshot.state, snapshot.recoverySessionId, snapshot.sessionId]);

  useEffect(() => {
    if (snapshot.state === 'processing') {
      setProcessingStartedAtMs((prev) => prev ?? Date.now());
      return;
    }
    setProcessingStartedAtMs(null);
  }, [snapshot.state]);

  async function refreshState() {
    try {
      const latest = (await chrome.runtime.sendMessage({ type: 'GET_STATE' })) as RecordingSnapshot;
      if (latest) setSnapshot(latest);
    } catch {
      // background waking
    }
  }

  async function send(type: string, extra?: Record<string, unknown>): Promise<CommandResponse> {
    setIsBusy(true);
    try {
      const result = (await chrome.runtime.sendMessage({ type, ...extra })) as CommandResponse;
      if (result?.snapshot) setSnapshot(result.snapshot);
      return result ?? null;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Message to background failed',
      };
    } finally {
      setIsBusy(false);
    }
  }

  async function handleStart(nextIncludeMicInput?: boolean | unknown) {
    const nextIncludeMic =
      typeof nextIncludeMicInput === 'boolean' ? nextIncludeMicInput : includeMic;

    if (isBusy) return;

    if (nextIncludeMic && !micReady) {
      return;
    }

    if (!nextIncludeMic) {
      await chrome.runtime.sendMessage({ type: 'RELEASE_MIC_CHECK' }).catch(() => {});
    }

    const prep = await send('PREPARE_START', { includeMic: nextIncludeMic });
    if (!prep?.ok) {
      try {
        let latest = (await chrome.runtime.sendMessage({ type: 'GET_STATE' })) as RecordingSnapshot | null;
        if (latest?.state !== 'armed') {
          for (let i = 0; i < 8; i += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
            latest = (await chrome.runtime.sendMessage({ type: 'GET_STATE' })) as RecordingSnapshot | null;
            if (latest?.state === 'armed') break;
          }
        }

        if (latest?.state === 'armed') {
          setSnapshot(latest);
        } else {
          const specificError =
            prep?.error ||
            latest?.errorMessage ||
            (latest?.state === 'preflight'
              ? 'Recorder is still preparing. Please wait a moment and try again.'
              : null);
          window.alert(specificError ?? 'Unable to prepare recording');
          return;
        }
      } catch {
        window.alert(prep?.error ?? 'Unable to prepare recording');
        return;
      }
    }

    const start = await send('START', { audioSource: nextIncludeMic ? 'both' : 'tab' });
    if (!start?.ok) {
      window.alert(start?.error ?? 'Unable to start recording');
    }
  }

  async function handleStop() {
    await send('STOP');
  }

  async function handleDownload() {
    await send('DOWNLOAD');
  }

  async function handleContinueMicOnly() {
    await send('SYSTEM_AUDIO_CONTINUE');
  }

  async function handleStopRetry() {
    await send('SYSTEM_AUDIO_STOP_RETRY');
  }

  async function handleRecoverOrphan(sessionId: string) {
    await send('RECOVER_ORPHAN', { sessionId });
  }

  async function handleDiscardOrphan(sessionId: string) {
    await send('DISCARD_ORPHAN', { sessionId });
  }

  async function handleProcessSelected() {
    const targetSessionId =
      snapshot.recoverySessionId ?? snapshot.sessionId ?? snapshot.orphanedSessions[0]?.sessionId ?? null;
    if (!targetSessionId) return;
    const nonMissing = snapshot.recoveryChunks
      .filter((chunk) => chunk.status !== 'missing')
      .map((chunk) => chunk.index);
    const chunkIndexes = selectedRecoveryChunks.length ? selectedRecoveryChunks : nonMissing;

    const result = await send(
      'RECOVER_ORPHAN',
      chunkIndexes.length
        ? {
            sessionId: targetSessionId,
            chunkIndexes,
          }
        : { sessionId: targetSessionId },
    );
    if (!result?.ok) {
      window.alert(result?.error ?? 'Failed to process selected chunks');
    }
  }

  async function handleDownloadRaw() {
    const targetSessionId =
      snapshot.recoverySessionId ?? snapshot.sessionId ?? snapshot.orphanedSessions[0]?.sessionId ?? null;
    if (!targetSessionId) return;
    const result = await send('DOWNLOAD_RAW_CHUNKS', { sessionId: targetSessionId });
    if (!result?.ok) {
      window.alert(result?.error ?? 'Failed to download raw chunks');
    }
  }

  async function handleClearState() {
    const result = await send('RESET_TO_IDLE');
    if (!result?.ok) {
      window.alert(result?.error ?? 'Unable to clear recovery state');
    }
  }

  function handleToggleChunk(index: number, checked: boolean) {
    setSelectedRecoveryChunks((prev) => {
      const s = new Set(prev);
      if (checked) {
        s.add(index);
      } else {
        s.delete(index);
      }
      return [...s].sort((a, b) => a - b);
    });
  }

  function handleSettings() {
    void chrome.runtime.openOptionsPage?.();
  }

  async function handleRecordAgain() {
    const result = await send('RESET_TO_IDLE');
    if (!result?.ok) {
      window.alert(result?.error ?? 'Unable to reset recorder');
    }
  }

  const { state } = snapshot;
  const orphan = snapshot.orphanedSessions[0] ?? null;
  const canStart = STARTABLE_STATES.includes(state);
  const canStartRecording = !includeMic || micReady;
  const startButtonLabel = canStartRecording ? 'Start Recording' : 'Fix microphone to continue';
  const processingProgressValue =
    typeof snapshot.processingProgress === 'number' && Number.isFinite(snapshot.processingProgress)
      ? Math.max(0, Math.min(100, snapshot.processingProgress))
      : null;
  const processingElapsedSeconds =
    processingStartedAtMs === null ? null : Math.max(0, (Date.now() - processingStartedAtMs) / 1000);
  const processingEtaSeconds =
    state === 'processing' &&
    processingStartedAtMs !== null &&
    processingProgressValue !== null &&
    processingProgressValue >= 8 &&
    processingElapsedSeconds !== null
      ? (() => {
          const rawEta =
            processingElapsedSeconds / (processingProgressValue / 100) - processingElapsedSeconds;
          if (!Number.isFinite(rawEta) || rawEta < 0 || rawEta > 300) return null;
          return Math.round(rawEta);
        })()
      : null;

  return (
    <div className="rk-root">
      <Header state={state} onSettings={handleSettings} />

      {(state === 'idle' || (state === 'done' && snapshot.orphanedSessions.length > 0)) && (
        <IdleScreen
          micControl={
            <MicToggleCard
              includeMic={includeMic}
              onMicChange={setIncludeMic}
              onReadyChange={setMicReady}
            />
          }
          onStart={handleStart}
          isBusy={isBusy || !canStart}
          canStartRecording={canStartRecording}
          startButtonLabel={startButtonLabel}
          orphan={orphan}
          onRecoverOrphan={handleRecoverOrphan}
          onDiscardOrphan={handleDiscardOrphan}
          storageWarning={snapshot.storageWarningMessage}
        />
      )}

      {state === 'preflight' && (
        <PreflightScreen
          audioPreflight={snapshot.audioPreflight}
          includeMic={includeMic}
          onConfirm={handleStart}
          onBack={() => setSnapshot((p) => ({ ...p, state: 'idle' }))}
          isBusy={isBusy}
        />
      )}

      {state === 'preflight_error' && (
        <PreflightErrorScreen
          audioPreflight={snapshot.audioPreflight}
          includeMic={includeMic}
          onRetry={handleStart}
          onBack={() => setSnapshot((p) => ({ ...p, state: 'idle' }))}
          onContinueWithoutMic={() => {
            setIncludeMic(false);
            void handleStart(false);
          }}
          isBusy={isBusy}
        />
      )}

      {state === 'armed' && <ArmedScreen onCancel={() => void send('CANCEL_START')} />}

      {state === 'recording' && <RecordingScreen snapshot={snapshot} onStop={handleStop} isBusy={isBusy} />}

      {state === 'audio_warning' && (
        <AudioWarningScreen
          snapshot={snapshot}
          onContinueMicOnly={handleContinueMicOnly}
          onStopRetry={handleStopRetry}
          onStop={handleStop}
          isBusy={isBusy}
        />
      )}

      {state === 'stopping' && <StoppingScreen snapshot={snapshot} />}

      {(state === 'processing' || state === 'validating') && (
        <ProcessingScreen
          snapshot={snapshot}
          phase={state}
          etaSeconds={state === 'processing' ? processingEtaSeconds : null}
        />
      )}

      {state === 'done' && snapshot.orphanedSessions.length === 0 && (
        <DoneScreen
          snapshot={snapshot}
          onDownload={handleDownload}
          onRecordAgain={handleRecordAgain}
          isBusy={isBusy}
        />
      )}

      {state === 'recovery' && (
        <RecoveryScreen
          snapshot={snapshot}
          selectedChunks={selectedRecoveryChunks}
          onToggleChunk={handleToggleChunk}
          onProcessSelected={handleProcessSelected}
          onDownloadRaw={handleDownloadRaw}
          onClearState={handleClearState}
          isBusy={isBusy}
        />
      )}

      {state === 'error' && (
        <ErrorScreen
          message={snapshot.errorMessage ?? 'An unexpected error occurred.'}
          onRetry={handleStart}
          isBusy={isBusy}
        />
      )}
    </div>
  );
}
