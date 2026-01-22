"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* -----------------------------
   Helpers (Math + Formatting)
------------------------------ */
function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function fmtEUR(n: number, frac = 0) {
  if (!isFinite(n)) return "–";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: frac,
    minimumFractionDigits: frac,
  }).format(n);
}

function fmtPct(n: number, frac = 0) {
  if (!isFinite(n)) return "–";
  return (n * 100).toFixed(frac) + "%";
}

function pow1p(r: number, t: number) {
  return Math.pow(1 + r, t);
}

function yearsBetween(a: Date, b: Date) {
  let years = b.getFullYear() - a.getFullYear();
  const m = b.getMonth() - a.getMonth();
  if (m < 0 || (m === 0 && b.getDate() < a.getDate())) years--;
  return years;
}

function addYears(d: Date, years: number) {
  const x = new Date(d);
  x.setFullYear(x.getFullYear() + years);
  return x;
}

/**
 * Integer months between dates.
 * (b earlier day-of-month => subtract last incomplete month)
 */
function monthsBetween(a: Date, b: Date) {
  let m =
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m -= 1;
  return m;
}

function pvAnnuity(pmt: number, r_m: number, n: number) {
  if (n <= 0) return 0;
  if (Math.abs(r_m) < 1e-12) return pmt * n;
  return (pmt * (1 - Math.pow(1 + r_m, -n))) / r_m;
}

function pmtForFV(fv: number, r_m: number, n: number) {
  if (n <= 0) return Infinity;
  if (fv <= 0) return 0;
  if (Math.abs(r_m) < 1e-12) return fv / n;
  const denom = Math.pow(1 + r_m, n) - 1;
  if (denom <= 0) return Infinity;
  return (fv * r_m) / denom;
}

function fvAnnuity(pmt: number, r_m: number, n: number) {
  if (n <= 0) return 0;
  if (Math.abs(r_m) < 1e-12) return pmt * n;
  return (pmt * (Math.pow(1 + r_m, n) - 1)) / r_m;
}

function payoutFromCapital(capital: number, r_m: number, n: number) {
  if (capital <= 0 || n <= 0) return 0;
  const pvaf = pvAnnuity(1, r_m, n);
  if (pvaf <= 0) return 0;
  return capital / pvaf;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function formatDEDate(d: Date) {
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function toTodayPurchasingPower(
  valueNominal: number,
  inflFactor: number,
  on: boolean
) {
  return on ? valueNominal / inflFactor : valueNominal;
}

/* -----------------------------
   Germany basics (approx/tool-grade)
------------------------------ */
type GermanState =
  | "baden_wuerttemberg"
  | "bayern"
  | "berlin"
  | "brandenburg"
  | "bremen"
  | "hamburg"
  | "hessen"
  | "mecklenburg_vorpommern"
  | "niedersachsen"
  | "nordrhein_westfalen"
  | "rheinland_pfalz"
  | "saarland"
  | "sachsen"
  | "sachsen_anhalt"
  | "schleswig_holstein"
  | "thueringen";

const STATES: { key: GermanState; label: string }[] = [
  { key: "baden_wuerttemberg", label: "Baden-Württemberg" },
  { key: "bayern", label: "Bayern" },
  { key: "berlin", label: "Berlin" },
  { key: "brandenburg", label: "Brandenburg" },
  { key: "bremen", label: "Bremen" },
  { key: "hamburg", label: "Hamburg" },
  { key: "hessen", label: "Hessen" },
  { key: "mecklenburg_vorpommern", label: "Mecklenburg-Vorpommern" },
  { key: "niedersachsen", label: "Niedersachsen" },
  { key: "nordrhein_westfalen", label: "Nordrhein-Westfalen" },
  { key: "rheinland_pfalz", label: "Rheinland-Pfalz" },
  { key: "saarland", label: "Saarland" },
  { key: "sachsen", label: "Sachsen" },
  { key: "sachsen_anhalt", label: "Sachsen-Anhalt" },
  { key: "schleswig_holstein", label: "Schleswig-Holstein" },
  { key: "thueringen", label: "Thüringen" },
];

function churchTaxRateByState(st: GermanState) {
  return st === "bayern" || st === "baden_wuerttemberg" ? 0.08 : 0.09;
}

/**
 * Pension taxable share (cohort, simplified but policy-shaped)
 * 2005: 50%
 * 2006-2020: +2pp
 * 2021-2057: +1pp
 * 2058+: 100%
 */
function pensionTaxableShare(retYear: number) {
  if (retYear >= 2058) return 1.0;
  if (retYear <= 2005) return 0.5;
  if (retYear <= 2020) return clamp(0.5 + 0.02 * (retYear - 2005), 0.5, 0.8);
  return clamp(0.8 + 0.01 * (retYear - 2020), 0.8, 1.0);
}

/**
 * Income tax approx (progressive, simplified).
 * This is not official §32a EStG, but tool-grade usable.
 */
function approxIncomeTaxGermany(annualTaxable: number) {
  if (!isFinite(annualTaxable) || annualTaxable <= 0) return 0;

  const grundfreibetrag = 12000;
  const z1 = 17000;
  const z2 = 66000;
  const z3 = 277000;

  const x = Math.max(0, annualTaxable - grundfreibetrag);

  const b1 = Math.max(0, Math.min(x, z1 - grundfreibetrag));
  const r1 =
    b1 * (0.14 + 0.1 * (b1 / Math.max(1, z1 - grundfreibetrag))) * 0.5 +
    b1 * 0.14 * 0.5;

  const b2 = Math.max(0, Math.min(x - (z1 - grundfreibetrag), z2 - z1));
  const r2 =
    b2 * (0.24 + 0.18 * (b2 / Math.max(1, z2 - z1))) * 0.5 + b2 * 0.24 * 0.5;

  const b3 = Math.max(0, Math.min(x - (z2 - grundfreibetrag), z3 - z2));
  const r3 = b3 * 0.42;

  const b4 = Math.max(0, x - (z3 - grundfreibetrag));
  const r4 = b4 * 0.45;

  return r1 + r2 + r3 + r4;
}

/* -----------------------------
   Hooks
------------------------------ */
function useIsMobile(breakpointPx = 980) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [breakpointPx]);
  return isMobile;
}

/* -----------------------------
   UI primitives
------------------------------ */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="label">{children}</div>;
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string | number;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      className="input"
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * NumberInput:
 * - erlaubt leeres Feld ("") ohne 0 zu erzwingen
 * - commit onBlur/Enter
 */
function NumberInput({
  value,
  onChange,
  step,
  min,
  max,
  placeholder,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState<string>(String(value));

  useEffect(() => {
    const asStr = String(value);
    if (raw !== "" && Number(raw) === value) return;
    setRaw(asStr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (s: string) => {
    if (s.trim() === "" || s === "-" || s === ".") return;
    const n = Number(s);
    if (!isFinite(n)) return;
    let v = n;
    if (typeof min === "number") v = Math.max(min, v);
    if (typeof max === "number") v = Math.min(max, v);
    onChange(v);
  };

  return (
    <input
      className="input"
      inputMode="decimal"
      type="text"
      value={raw}
      placeholder={placeholder}
      onChange={(e) => {
        const s = e.target.value.replace(",", ".");
        if (!/^-?\d*\.?\d*$/.test(s)) return;
        setRaw(s);
        if (s !== "" && s !== "-" && s !== "." && isFinite(Number(s))) {
          commit(s);
        }
      }}
      onBlur={() => {
        if (raw.trim() === "") {
          const fallback = typeof min === "number" ? min : 0;
          setRaw(String(fallback));
          onChange(fallback);
          return;
        }
        commit(raw);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      step={step}
    />
  );
}

/* -----------------------------
   Range (robust for mobile Safari)
------------------------------ */
function Range({
  label,
  value,
  min,
  max,
  step,
  suffix = "%",
  onValue,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onValue: (n: number) => void;
}) {
  const setFromTarget = (t: HTMLInputElement) => {
    const n = Number.isFinite(t.valueAsNumber)
      ? t.valueAsNumber
      : Number(t.value);
    onValue(n);
  };

  return (
    <div className="ctrl">
      <div className="ctrlTop">
        <span>{label}</span>
        <span className="pill">
          {value.toFixed(1)}
          {suffix}
        </span>
      </div>
      <input
        className="range"
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setFromTarget(e.currentTarget)}
        onInput={(e) => setFromTarget(e.currentTarget as HTMLInputElement)}
        onTouchMove={(e) => setFromTarget(e.currentTarget as HTMLInputElement)}
        onPointerMove={(e) =>
          setFromTarget(e.currentTarget as HTMLInputElement)
        }
      />
    </div>
  );
}

/* -----------------------------
   Segmented control
------------------------------ */
function Segmented({
  label,
  value,
  options,
  onChange,
  compact,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  compact?: boolean;
}) {
  return (
    <div className="segWrap">
      <div className="label">{label}</div>
      <div className={"seg " + (compact ? "segCompact" : "")}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              className={"segBtn " + (active ? "segBtnActive" : "")}
              onClick={() => onChange(o.value)}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* -----------------------------
   Collapse Card + Icons
------------------------------ */
type IconName = "user" | "shield" | "target" | "euro" | "pig" | "trend";

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
  };
  const stroke = {
    stroke: "var(--green)",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "user":
      return (
        <svg {...common}>
          <path {...stroke} d="M20 21a8 8 0 0 0-16 0" />
          <circle {...stroke} cx="12" cy="7" r="4" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path {...stroke} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path {...stroke} d="M9 12l2 2 4-5" />
        </svg>
      );
    case "target":
      return (
        <svg {...common}>
          <circle {...stroke} cx="12" cy="12" r="9" />
          <circle {...stroke} cx="12" cy="12" r="5" />
          <path {...stroke} d="M12 7v2" />
          <path {...stroke} d="M12 15v2" />
        </svg>
      );
    case "euro":
      return (
        <svg {...common}>
          <path {...stroke} d="M17 7.5a6 6 0 0 0-10 4.5 6 6 0 0 0 10 4.5" />
          <path {...stroke} d="M7 10h8" />
          <path {...stroke} d="M7 14h8" />
        </svg>
      );
    case "pig":
      return (
        <svg {...common}>
          <path
            {...stroke}
            d="M4 12a7 7 0 0 1 12-4h2l2 2-2 2v2a7 7 0 0 1-12 4"
          />
          <path {...stroke} d="M7 16v2" />
          <path {...stroke} d="M13 16v2" />
          <circle cx="10" cy="11" r="1" fill="var(--green)" />
        </svg>
      );
    case "trend":
      return (
        <svg {...common}>
          <path {...stroke} d="M3 17l6-6 4 4 7-7" />
          <path {...stroke} d="M14 8h6v6" />
        </svg>
      );
    default:
      return null;
  }
}

function CollapseCard({
  title,
  isOpen,
  onToggle,
  children,
  right,
  icon,
}: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  right?: React.ReactNode;
  icon: IconName;
}) {
  return (
    <div className="card">
      <button
        type="button"
        className="cardHead"
        onClick={onToggle}
        aria-label={title}
      >
        <div className="cardHeadLeft">
          <div className="badge" aria-hidden="true">
            <Icon name={icon} />
          </div>
          <div className="cardTitle">{title}</div>
        </div>
        <div className="cardHeadRight">
          {right}
          <div className="chev">{isOpen ? "▾" : "▸"}</div>
        </div>
      </button>
      {isOpen && <div className="cardBody">{children}</div>}
    </div>
  );
}

/* -----------------------------
   Date Picker (Portal: no clipping)
------------------------------ */
const MONTHS_DE = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];
const WEEKDAYS_DE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function startOfMonth(year: number, month: number) {
  return new Date(year, month, 1);
}
function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}
function weekdayMon0(d: Date) {
  const w = d.getDay();
  return (w + 6) % 7;
}

function DatePicker({
  label,
  value,
  onChange,
  minYear = 1900,
  maxYear,
}: {
  label: string;
  value: Date;
  onChange: (d: Date) => void;
  minYear?: number;
  maxYear: number;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(value.getFullYear());
  const [viewMonth, setViewMonth] = useState(value.getMonth());

  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const [popPos, setPopPos] = useState<{
    top: number;
    left: number;
    width: number;
  }>({
    top: 0,
    left: 0,
    width: 320,
  });

  useEffect(() => {
    setViewYear(value.getFullYear());
    setViewMonth(value.getMonth());
  }, [value]);

  const years = useMemo(() => {
    const arr: number[] = [];
    for (let y = maxYear; y >= minYear; y--) arr.push(y);
    return arr;
  }, [minYear, maxYear]);

  const grid = useMemo(() => {
    const first = startOfMonth(viewYear, viewMonth);
    const offset = weekdayMon0(first);
    const dim = daysInMonth(viewYear, viewMonth);

    const cells: { day: number; inMonth: boolean; date: Date }[] = [];
    const prevMonth = viewMonth === 0 ? 11 : viewMonth - 1;
    const prevYear = viewMonth === 0 ? viewYear - 1 : viewYear;
    const prevDim = daysInMonth(prevYear, prevMonth);

    for (let i = 0; i < offset; i++) {
      const day = prevDim - offset + 1 + i;
      cells.push({
        day,
        inMonth: false,
        date: new Date(prevYear, prevMonth, day),
      });
    }
    for (let d = 1; d <= dim; d++) {
      cells.push({
        day: d,
        inMonth: true,
        date: new Date(viewYear, viewMonth, d),
      });
    }
    while (cells.length < 42) {
      const last = cells[cells.length - 1].date;
      const next = new Date(last);
      next.setDate(last.getDate() + 1);
      cells.push({ day: next.getDate(), inMonth: false, date: next });
    }
    return cells;
  }, [viewYear, viewMonth]);

  const isSelected = (d: Date) =>
    d.getFullYear() === value.getFullYear() &&
    d.getMonth() === value.getMonth() &&
    d.getDate() === value.getDate();

  const moveMonth = (dir: -1 | 1) => {
    let y = viewYear;
    let m = viewMonth + dir;
    if (m < 0) {
      m = 11;
      y -= 1;
    } else if (m > 11) {
      m = 0;
      y += 1;
    }
    y = clamp(y, minYear, maxYear);
    setViewYear(y);
    setViewMonth(m);
  };

  const computePopPos = () => {
    const el = wrapRef.current;
    if (!el) return;
    const btn = el.querySelector(".dateBtn") as HTMLElement | null;
    const anchor = btn ?? el;
    const rect = anchor.getBoundingClientRect();

    const padding = 12;
    const maxW = Math.min(320, window.innerWidth - padding * 2);
    const left = clamp(rect.left, padding, window.innerWidth - padding - maxW);
    const top = rect.bottom + 10;

    setPopPos({ top, left, width: maxW });
  };

  useEffect(() => {
    if (!open) return;

    computePopPos();

    const onScroll = () => computePopPos();
    const onResize = () => computePopPos();

    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    const onDown = (e: MouseEvent) => {
      const wrap = wrapRef.current;
      const pop = popRef.current;
      const t = e.target as Node;
      if (wrap && wrap.contains(t)) return;
      if (pop && pop.contains(t)) return;
      setOpen(false);
    };

    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("mousedown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const popover = open ? (
    <div
      ref={popRef}
      className="datePop"
      style={{ top: popPos.top, left: popPos.left, width: popPos.width }}
    >
      <div className="dateTop">
        <button type="button" className="miniBtn" onClick={() => moveMonth(-1)}>
          ‹
        </button>
        <div className="dateMonth">{MONTHS_DE[viewMonth]}</div>
        <button type="button" className="miniBtn" onClick={() => moveMonth(1)}>
          ›
        </button>
      </div>

      <div className="dateYearRow">
        <select
          className="miniSelect"
          value={String(viewYear)}
          onChange={(e) => setViewYear(Number(e.target.value))}
          aria-label="Jahr"
        >
          {years.map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
        </select>
      </div>

      <div className="dateGridHead">
        {WEEKDAYS_DE.map((w) => (
          <div key={w} className="dateWd">
            {w}
          </div>
        ))}
      </div>

      <div className="dateGrid">
        {grid.map((c, idx) => {
          const selected = isSelected(c.date);
          return (
            <button
              key={idx}
              type="button"
              className={
                "dateCell " +
                (selected ? "dateCellSel" : "") +
                (c.inMonth ? "" : " dateCellDim")
              }
              onClick={() => {
                onChange(
                  new Date(
                    c.date.getFullYear(),
                    c.date.getMonth(),
                    c.date.getDate()
                  )
                );
                setOpen(false);
              }}
            >
              {c.day}
            </button>
          );
        })}
      </div>
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="dateWrap">
      <FieldLabel>{label}</FieldLabel>
      <button
        type="button"
        className="dateBtn"
        onClick={() => {
          setOpen((s) => !s);
          setTimeout(() => computePopPos(), 0);
        }}
      >
        <span>{formatDEDate(value)}</span>
        <span className="muted">▾</span>
      </button>

      {mounted && open ? createPortal(popover, document.body) : null}
    </div>
  );
}

/* -----------------------------
   Chart
------------------------------ */
type BarSeg = { label: string; value: number; color: string };
type Bar = { title: string; segments: BarSeg[] };

function Chart({
  bars,
  height = 520,
  fitToWidth = false,
  compact = false,
}: {
  bars: Bar[];
  height?: number;
  fitToWidth?: boolean;
  compact?: boolean;
}) {
  const maxVal = Math.max(
    1,
    ...bars.map((b) => b.segments.reduce((s, x) => s + Math.max(0, x.value), 0))
  );

  const chartH = height;
  const basePad = 22;
  const usableH = chartH - basePad;

  const gap = compact ? 10 : 14;

  return (
    <div className="chartOuter">
      <div className="chartBox" style={{ height: chartH }}>
        {[0.25, 0.5, 0.75, 1].map((p) => (
          <div
            key={p}
            className="chartGrid"
            style={{ top: 14 + usableH * (1 - p) }}
          />
        ))}

        <div className={"chartScroll " + (fitToWidth ? "chartNoX" : "")}>
          <div
            className="chartCols"
            style={{
              gridTemplateColumns: fitToWidth
                ? `repeat(${bars.length}, minmax(0, 1fr))`
                : `repeat(${bars.length}, minmax(260px, 1fr))`,
              gap,
              paddingRight: fitToWidth ? 0 : 24,
              width: fitToWidth ? "100%" : "max-content",
              minWidth: "100%",
            }}
          >
            {bars.map((bar) => {
              const total = bar.segments.reduce(
                (s, x) => s + Math.max(0, x.value),
                0
              );
              const totalH = (total / maxVal) * usableH;

              const segs = bar.segments
                .filter((s) => s.value > 0)
                .slice()
                .reverse();

              return (
                <div key={bar.title} className="barCol">
                  <div className="barStackWrap" style={{ height: usableH }}>
                    <div
                      className="barStack"
                      title={`${bar.title}: ${fmtEUR(total, 0)}`}
                      style={{ height: totalH }}
                    >
                      {segs.map((seg) => {
                        const h = (seg.value / maxVal) * usableH;
                        return (
                          <div
                            key={seg.label}
                            className="barSeg"
                            style={{ height: h, background: seg.color }}
                          >
                            <div className="barSegText">
                              <div className="barSegLabel">{seg.label}</div>
                              <div className="barSegVal">
                                {fmtEUR(seg.value, 0)}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="barTitle">{bar.title}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -----------------------------
   Main Page
------------------------------ */
export default function Page() {
  const today = new Date();
  const currentYear = today.getFullYear();
  const isMobile = useIsMobile(980);

  // ===== Lead-Magnet Video + CTA (Mobile) =====
  const driveFileId = "1De-VAB4nI9owQPhBkhO7SDtkVL4eZ4Lc";
  const videoEmbedUrl = `https://drive.google.com/file/d/${driveFileId}/preview`;
  const ctaUrl = "https://horbach-frankfurt.forms.app/finanzplan";
  const ctaText = "Jetzt Beratung Buchen!";

  // Inputs (left)
  const [dob, setDob] = useState<Date>(new Date(2000, 0, 1));
  const [jobEntry, setJobEntry] = useState<Date>(new Date(2020, 0, 1));
  const [state, setState] = useState<GermanState>("bayern");

  // Startwerte = 0
  const [monthlyGross, setMonthlyGross] = useState<number>(0);
  const [churchTax, setChurchTax] = useState<"yes" | "no">("no");

  const [retirementAge, setRetirementAge] = useState<number>(67);
  const [lifeExpectancy, setLifeExpectancy] = useState<number>(88);

  const [healthType, setHealthType] = useState<"legal" | "private">("legal");
  const [kvdr, setKvdr] = useState<"yes" | "no">("yes");
  const [pkvPremium, setPkvPremium] = useState<number>(450);

  // Startwert = 0
  const [targetNetToday, setTargetNetToday] = useState<number>(0);

  // Center controls
  const [inflationPct, setInflationPct] = useState<number>(2.0);
  const [returnSavingPct, setReturnSavingPct] = useState<number>(7.0);
  const [returnTakeoutPct, setReturnTakeoutPct] = useState<number>(2.0);
  const [adjustForPurchasePower, setAdjustForPurchasePower] =
    useState<boolean>(false);

  // Startwert = 0
  const [desiredSaving, setDesiredSaving] = useState<number>(0);

  const compare1 = 4;
  const compare2 = 8;

  // Collapse state
  const [openPerson, setOpenPerson] = useState(true);
  const [openHealth, setOpenHealth] = useState(true);
  const [openTarget, setOpenTarget] = useState(true);

  const [openCapital, setOpenCapital] = useState(true);
  const [openSavings, setOpenSavings] = useState(true);
  const [openInvest, setOpenInvest] = useState(true);

  // Hinweis: Werte eingeben
  const needsInputHint =
    monthlyGross <= 0 && targetNetToday <= 0 && desiredSaving <= 0;

  const calc = useMemo(() => {
    // Plausibilitätscheck
    const ageNow = yearsBetween(dob, today);
    if (ageNow < 0 || ageNow > 110)
      return { ok: false as const, error: "Geburtsdatum unplausibel." };

    // =========================
    // Calibration knobs (tool-grade)
    // =========================
    const AVG_EARNINGS_NOW = 50000;
    const BBG_ANNUAL = 90600;
    const RENTENWERT_NOW = 39.32;
    const RENTENWERT_GROWTH = 0.01;
    const EP_CAP = 2.05;

    const MED_INFLATION = 0.03; // PKV escalation
    const ADD_KV = 0.016; // Zusatzbeitrag total
    const KV_GENERAL = 0.146; // GKV total
    const PV_RATE = 0.034; // Pflege total

    // =========================
    // Time axis
    // =========================
    const retirementDate = addYears(dob, retirementAge);
    const monthsToRet = monthsBetween(today, retirementDate);
    if (monthsToRet <= 0)
      return {
        ok: false as const,
        error: "Renteneintritt liegt in der Vergangenheit.",
      };

    const yearsToRet = monthsToRet / 12;

    const retirementYears = clamp(lifeExpectancy - retirementAge, 5, 45);
    const monthsRet = Math.round(retirementYears * 12);

    // rates
    const infl = clamp(inflationPct / 100, 0, 0.2);
    const rAccNom = clamp(returnSavingPct / 100, 0, 0.3);
    const rDecNom = clamp(returnTakeoutPct / 100, 0, 0.3);

    const rAcc = adjustForPurchasePower
      ? Math.max(-0.99, rAccNom - infl)
      : rAccNom;
    const rDec = adjustForPurchasePower
      ? Math.max(-0.99, rDecNom - infl)
      : rDecNom;

    const rAcc_m = rAcc / 12;
    const rDec_m = rDec / 12;

    // inflation factor (float years)
    const inflFactor = pow1p(infl, yearsToRet);
    const targetInflated = targetNetToday * inflFactor;

    // =========================
    // Private pension from desired saving
    // =========================
    const fvDesired = fvAnnuity(desiredSaving, rAcc_m, monthsToRet);
    const privatePayout = payoutFromCapital(fvDesired, rDec_m, monthsRet);

    // =========================
    // Statutory pension: EP model with BBG
    // =========================
    const monthsWork = Math.max(0, monthsBetween(jobEntry, retirementDate));
    const workYears = Math.max(0, Math.floor(monthsWork / 12));

    const annualGrossNow = Math.max(0, monthlyGross * 12);

    // Wage growth: inflation + 1% real
    const wageGrowth = clamp(infl + 0.01, 0, 0.06);

    let totalEP = 0;
    for (let i = 0; i < workYears; i++) {
      const gross_i = annualGrossNow * pow1p(wageGrowth, i);
      const contributable = Math.min(gross_i, BBG_ANNUAL);
      const avg_i = AVG_EARNINGS_NOW * pow1p(wageGrowth, i);
      const ep = clamp(avg_i <= 0 ? 0 : contributable / avg_i, 0, EP_CAP);
      totalEP += ep;
    }

    const rentenwertAtRet =
      RENTENWERT_NOW * pow1p(RENTENWERT_GROWTH, yearsToRet);
    const statutoryGrossAtRet = totalEP * rentenwertAtRet; // monthly gross

    // =========================
    // Health contributions (KVdR delta like tools)
    // - KVdR: half KV + half add + full PV
    // - No KVdR: full KV + full add + full PV
    // =========================
    const kvHalf = KV_GENERAL / 2 + ADD_KV / 2;
    const kvFull = KV_GENERAL + ADD_KV;

    const kvRateOnPension = (kvdr === "yes" ? kvHalf : kvFull) + PV_RATE;
    const gkvDeduction = statutoryGrossAtRet * kvRateOnPension;

    const pkvAtRet = pkvPremium * pow1p(MED_INFLATION, yearsToRet);

    // =========================
    // Tax modeling (tool-like)
    // =========================
    const retirementYear = retirementDate.getFullYear();
    const taxableShare = pensionTaxableShare(retirementYear);

    const annualTaxableBase = Math.max(
      0,
      statutoryGrossAtRet * 12 * taxableShare
    );
    const annualIncomeTax = approxIncomeTaxGermany(annualTaxableBase);
    const monthlyIncomeTax = annualIncomeTax / 12;

    const hasChurchTax = churchTax === "yes";
    const churchRate = churchTaxRateByState(state);
    const monthlyChurchTax = hasChurchTax ? monthlyIncomeTax * churchRate : 0;

    // =========================
    // Net statutory pension
    // =========================
    let statutoryNet_nominal = 0;

    if (healthType === "legal") {
      statutoryNet_nominal = Math.max(
        0,
        statutoryGrossAtRet - gkvDeduction - monthlyIncomeTax - monthlyChurchTax
      );
    } else {
      statutoryNet_nominal = Math.max(
        0,
        statutoryGrossAtRet - pkvAtRet - monthlyIncomeTax - monthlyChurchTax
      );
    }

    const statutoryNetForChart = toTodayPurchasingPower(
      statutoryNet_nominal,
      inflFactor,
      adjustForPurchasePower
    );

    // =========================
    // Target & gap
    // =========================
    const targetForChart = adjustForPurchasePower
      ? targetNetToday
      : targetInflated;

    const achievedPension = statutoryNetForChart + privatePayout;
    const gap = Math.max(0, targetForChart - achievedPension);

    // =========================
    // Required capital & savings (TOP-UP for remaining gap)
    // =========================
    const requiredCapital = pvAnnuity(gap, rDec_m, monthsRet);
    const requiredSavingNow = pmtForFV(requiredCapital, rAcc_m, monthsToRet); // top-up needed to close remaining gap

    const requiredSavingDelayed = (delayYears: number) => {
      const m = monthsToRet - delayYears * 12;
      return pmtForFV(requiredCapital, rAcc_m, m);
    };

    const requiredIn4 = requiredSavingDelayed(compare1);
    const requiredIn8 = requiredSavingDelayed(compare2);

    // =========================
    // FIX: Coverage must only reach 100% when the gap is actually closed.
    // Coverage is measured as: current saving / (current saving + required top-up)
    // => 100% only when requiredSavingNow == 0 (i.e., gap == 0).
    // =========================
    const topUp = isFinite(requiredSavingNow)
      ? Math.max(0, requiredSavingNow)
      : Infinity;
    const denom = desiredSaving + topUp;

    const coverage =
      topUp <= 1e-9
        ? 1
        : !isFinite(denom) || denom <= 0
        ? 0
        : clamp(desiredSaving / denom, 0, 1);

    // =========================
    // Capital/interest projections for current desiredSaving (unchanged)
    // =========================
    const capitalNow = fvDesired;
    const contribNow = desiredSaving * monthsToRet;
    const interestNow = capitalNow - contribNow;

    const fvIn = (delayYears: number) => {
      const m = monthsToRet - delayYears * 12;
      return fvAnnuity(desiredSaving, rAcc_m, m);
    };

    const capitalIn4 = fvIn(compare1);
    const capitalIn8 = fvIn(compare2);

    const contribIn4 = desiredSaving * Math.max(0, monthsToRet - compare1 * 12);
    const contribIn8 = desiredSaving * Math.max(0, monthsToRet - compare2 * 12);

    const interestIn4 = capitalIn4 - contribIn4;
    const interestIn8 = capitalIn8 - contribIn8;

    // =========================
    // Bars
    // =========================
    const bars: Bar[] = [];
    bars.push({
      title: "Versorgungsziel",
      segments: [
        {
          label: "Versorgungsziel",
          value: targetNetToday,
          color: "var(--greyBar)",
        },
      ],
    });

    if (!adjustForPurchasePower) {
      bars.push({
        title: "Ziel mit Inflation",
        segments: [
          {
            label: "Ziel mit Inflation",
            value: targetInflated,
            color: "var(--greyBarDark)",
          },
        ],
      });
    }

    bars.push({
      title: adjustForPurchasePower ? "Rente (heute)" : "Rente",
      segments: [
        {
          label: "Gesetzliche Rente Netto",
          value: statutoryNetForChart,
          color: "var(--blue)",
        },
        { label: "Rente", value: privatePayout, color: "var(--green)" },
        { label: "Versorgungslücke", value: gap, color: "var(--red)" },
      ],
    });

    return {
      ok: true as const,
      gap,
      requiredCapital,
      requiredSavingNow: topUp, // keep name, but now explicitly top-up
      requiredIn4,
      requiredIn8,
      coverage,
      capitalNow,
      capitalIn4,
      capitalIn8,
      interestNow,
      interestIn4,
      interestIn8,
      bars,
    };
  }, [
    dob,
    jobEntry,
    state,
    monthlyGross,
    churchTax,
    retirementAge,
    lifeExpectancy,
    healthType,
    kvdr,
    pkvPremium,
    targetNetToday,
    inflationPct,
    returnSavingPct,
    returnTakeoutPct,
    adjustForPurchasePower,
    desiredSaving,
    today,
  ]);

  // Mobile: nur den 3. Balken (Rente) zeigen
  const barsMobile = useMemo(() => {
    if (!calc.ok) return { hero: null as any };
    return { hero: calc.bars[calc.bars.length - 1] };
  }, [calc]);

  // Gesamtrente aus dem tatsächlich gerenderten Renten-Balken ableiten (blau+grün)
  const totalPensionDisplay = useMemo(() => {
    if (!calc.ok) return 0;
    const rentBar = calc.bars[calc.bars.length - 1];
    const blue =
      rentBar.segments.find((s) =>
        s.label.toLowerCase().includes("gesetzliche")
      )?.value ?? 0;
    const green =
      rentBar.segments.find((s) => s.color === "var(--green)")?.value ?? 0;
    const total = blue + green;
    return isFinite(total) ? total : 0;
  }, [calc]);

  /* -----------------------------
     Blocks
  ------------------------------ */
  const LeftStack = (
    <div className="stack">
      <CollapseCard
        title="Angaben zur Person"
        icon="user"
        isOpen={openPerson}
        onToggle={() => setOpenPerson((v) => !v)}
      >
        <div className="form">
          <DatePicker
            label="Geburtsdatum"
            value={dob}
            onChange={setDob}
            minYear={1900}
            maxYear={currentYear}
          />
          <DatePicker
            label="Berufseintritt"
            value={jobEntry}
            onChange={setJobEntry}
            minYear={1900}
            maxYear={currentYear}
          />

          <div className="field">
            <FieldLabel>Bundesland</FieldLabel>
            <Select
              value={state}
              onChange={(v) => setState(v as GermanState)}
              options={STATES.map((s) => ({ value: s.key, label: s.label }))}
            />
          </div>

          <div className="field">
            <FieldLabel>Brutto / Monat</FieldLabel>
            <NumberInput
              value={monthlyGross}
              min={0}
              step={50}
              onChange={(v) => setMonthlyGross(Math.max(0, v))}
            />
          </div>

          <Segmented
            label="Kirchensteuerpflichtig"
            value={churchTax}
            onChange={(v) => setChurchTax(v as "yes" | "no")}
            options={[
              { value: "yes", label: "Ja" },
              { value: "no", label: "Nein" },
            ]}
            compact
          />
        </div>
      </CollapseCard>

      <CollapseCard
        title="Krankenversicherung im Alter"
        icon="shield"
        isOpen={openHealth}
        onToggle={() => setOpenHealth((v) => !v)}
      >
        <div className="form">
          <Segmented
            label="Art der Krankenversicherung"
            value={healthType}
            onChange={(v) => setHealthType(v as "legal" | "private")}
            options={[
              { value: "legal", label: "Gesetzlich" },
              { value: "private", label: "Privat" },
            ]}
            compact
          />

          {healthType === "private" && (
            <div className="field">
              <FieldLabel>PKV / Monat</FieldLabel>
              <NumberInput
                value={pkvPremium}
                min={0}
                step={10}
                onChange={(v) => setPkvPremium(Math.max(0, v))}
              />
            </div>
          )}

          <Segmented
            label="Mit KVdR"
            value={kvdr}
            onChange={(v) => setKvdr(v as "yes" | "no")}
            options={[
              { value: "yes", label: "Ja" },
              { value: "no", label: "Nein" },
            ]}
            compact
          />

          <div className="two">
            <div className="field">
              <FieldLabel>Rente ab</FieldLabel>
              <NumberInput
                value={retirementAge}
                min={55}
                max={75}
                step={1}
                onChange={(v) => setRetirementAge(clamp(v, 55, 75))}
              />
            </div>
            <div className="field">
              <FieldLabel>Leben</FieldLabel>
              <NumberInput
                value={lifeExpectancy}
                min={70}
                max={100}
                step={1}
                onChange={(v) => setLifeExpectancy(clamp(v, 70, 100))}
              />
            </div>
          </div>
        </div>
      </CollapseCard>

      <CollapseCard
        title="Versorgungsziel"
        icon="target"
        isOpen={openTarget}
        onToggle={() => setOpenTarget((v) => !v)}
      >
        <div className="form">
          <div className="field">
            <FieldLabel>Netto / Monat</FieldLabel>
            <NumberInput
              value={targetNetToday}
              min={0}
              step={50}
              onChange={(v) => setTargetNetToday(Math.max(0, v))}
            />
          </div>
        </div>
      </CollapseCard>
    </div>
  );

  const CenterCard = (
    <div className="centerCard">
      <div className="centerHead">
        <div className="centerTitle">Vorsorgeverteilung</div>

        <div className="controls">
          <Range
            label="Inflation"
            value={inflationPct}
            min={0}
            max={5}
            step={0.1}
            onValue={setInflationPct}
          />
          <Range
            label="Rendite (Anspar)"
            value={returnSavingPct}
            min={0}
            max={14}
            step={0.1}
            onValue={setReturnSavingPct}
          />
          <Range
            label="Rendite (Entnahme)"
            value={returnTakeoutPct}
            min={0}
            max={14}
            step={0.1}
            onValue={setReturnTakeoutPct}
          />

          <div className="ctrl toggleCtrl">
            <div className="ctrlTop">
              <span>Kaufkraft</span>
            </div>
            <div className="seg miniSeg">
              <button
                type="button"
                className={
                  "segBtn " + (!adjustForPurchasePower ? "segBtnActive" : "")
                }
                onClick={() => setAdjustForPurchasePower(false)}
              >
                Aus
              </button>
              <button
                type="button"
                className={
                  "segBtn " + (adjustForPurchasePower ? "segBtnActive" : "")
                }
                onClick={() => setAdjustForPurchasePower(true)}
              >
                An
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="centerBody">
        {!calc.ok ? (
          <div className="error">{calc.error}</div>
        ) : (
          <>
            {needsInputHint && (
              <div className="hintBox">
                Bitte Werte eingeben (Brutto, Versorgungsziel oder Sparrate), um
                eine realistische Gesamtrente zu sehen.
              </div>
            )}

            {isMobile ? (
              <div className="mobileCharts">
                <Chart
                  bars={[barsMobile.hero]}
                  height={420}
                  fitToWidth
                  compact
                />
              </div>
            ) : (
              <Chart bars={calc.bars} height={520} />
            )}

            <div className="totalPillWrap">
              <div className="totalPill">
                Gesamtrente: {fmtEUR(totalPensionDisplay, 2)}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );

  const RightStack = (
    <div className="stack">
      <CollapseCard
        title="Benötigtes Kapital"
        icon="euro"
        isOpen={openCapital}
        onToggle={() => setOpenCapital((v) => !v)}
        right={
          !calc.ok ? null : (
            <span className="rightHeadVal">
              {fmtEUR(calc.requiredCapital, 0)}
            </span>
          )
        }
      >
        {!calc.ok ? null : (
          <div className="bigNumber">{fmtEUR(calc.requiredCapital, 0)}</div>
        )}
      </CollapseCard>

      <CollapseCard
        title="Notwendige Sparrate"
        icon="pig"
        isOpen={openSavings}
        onToggle={() => setOpenSavings((v) => !v)}
        right={
          !calc.ok ? null : (
            <span className="rightHeadVal green">
              {fmtEUR(calc.requiredSavingNow, 2)}
            </span>
          )
        }
      >
        {!calc.ok ? null : (
          <div className="rightBlock">
            <div className="bigNumber green">
              {fmtEUR(calc.requiredSavingNow, 2)}
            </div>

            <div className="twoMini">
              <div className="miniCard warn">
                <div className="miniTop">In 4 Jahren</div>
                <div className="miniVal">{fmtEUR(calc.requiredIn4, 2)}</div>
              </div>
              <div className="miniCard danger">
                <div className="miniTop">In 8 Jahren</div>
                <div className="miniVal">{fmtEUR(calc.requiredIn8, 2)}</div>
              </div>
            </div>
          </div>
        )}
      </CollapseCard>

      <CollapseCard
        title="Investitionswunsch"
        icon="trend"
        isOpen={openInvest}
        onToggle={() => setOpenInvest((v) => !v)}
      >
        <div className="form">
          <div className="field">
            <FieldLabel>Sparrate / Monat</FieldLabel>
            <NumberInput
              value={desiredSaving}
              min={0}
              step={10}
              onChange={(v) => setDesiredSaving(Math.max(0, v))}
            />
          </div>

          {!calc.ok ? null : (
            <>
              <div className="barRow">
                <span className="mutedSm">Abdeckung</span>
                <span className="bold">{fmtPct(calc.coverage, 0)}</span>
              </div>
              <div className="progress">
                <div
                  className="progressIn"
                  style={{ width: String(calc.coverage * 100) + "%" }}
                />
              </div>

              <div className="divider" />

              <div className="kv">
                <div className="kvTitle">Kapital</div>
                <div className="kvRow">
                  <span>Heute</span>
                  <span className="bold">{fmtEUR(calc.capitalNow, 0)}</span>
                </div>
                <div className="kvRow">
                  <span>In 4 J.</span>
                  <span className="bold">{fmtEUR(calc.capitalIn4, 0)}</span>
                </div>
                <div className="kvRow">
                  <span>In 8 J.</span>
                  <span className="bold">{fmtEUR(calc.capitalIn8, 0)}</span>
                </div>

                <div className="kvTitle mt">Zinsgewinn</div>
                <div className="kvRow">
                  <span>Heute</span>
                  <span className="bold">{fmtEUR(calc.interestNow, 0)}</span>
                </div>
                <div className="kvRow">
                  <span>In 4 J.</span>
                  <span className="bold">{fmtEUR(calc.interestIn4, 0)}</span>
                </div>
                <div className="kvRow">
                  <span>In 8 J.</span>
                  <span className="bold">{fmtEUR(calc.interestIn8, 0)}</span>
                </div>
              </div>
            </>
          )}
        </div>
      </CollapseCard>
    </div>
  );

  return (
    <main className="page">
      <div className="wrap">
        <div className="topbar">
          <div className="h1">Altersvorsorge</div>
          <div className="topHint">Live-Rechner</div>
        </div>

        {isMobile ? (
          <div className="mobileFlow">
            {LeftStack}
            {CenterCard}
            {RightStack}
          </div>
        ) : (
          <div className="grid">
            <aside className="col colLeft">{LeftStack}</aside>
            <section className="col colCenter">{CenterCard}</section>
            <aside className="col colRight">{RightStack}</aside>
          </div>
        )}

        {/* ===== Mobile Lead Magnet: Video (9:16) + CTA ===== */}
        {isMobile && (
          <section className="leadWrap" aria-label="Beratungsvideo und CTA">
            <div className="leadCard">
              <div className="leadTitle">Kurzes Video (1–2 Min.)</div>

              <div className="leadVideo">
                <iframe
                  className="leadIframe"
                  src={videoEmbedUrl}
                  allow="autoplay; fullscreen; picture-in-picture"
                  allowFullScreen
                  title="Erklärvideo"
                />
              </div>

              <a
                className="leadBtn"
                href={ctaUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {ctaText}
              </a>
            </div>
          </section>
        )}
      </div>

      <style jsx global>{`
        :root {
          --bg: #f6f7f9;
          --card: #ffffff;
          --border: #e6e8ec;
          --muted: #667085;
          --text: #111827;
          --shadow: 0 10px 24px rgba(16, 24, 40, 0.08);
          --shadowSm: 0 1px 2px rgba(16, 24, 40, 0.06);
          --green: #16a34a;
          --blue: #1f6feb;
          --red: #ef4444;
          --greyBar: #98a2b3;
          --greyBarDark: #667085;
        }
        * {
          box-sizing: border-box;
        }
        body {
          margin: 0;
          background: var(--bg);
          color: var(--text);
          font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
        }

        .page {
          height: 100vh;
          overflow: hidden;
          padding: 16px;
        }
        .wrap {
          max-width: 1400px;
          margin: 0 auto;
          height: 100%;
          display: grid;
          grid-template-rows: 56px 1fr;
          gap: 14px;
          min-height: 0;
        }

        .topbar {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          gap: 12px;
          padding: 0 2px;
        }
        .h1 {
          font-size: 22px;
          font-weight: 950;
          letter-spacing: -0.01em;
        }
        .topHint {
          font-size: 12px;
          color: var(--muted);
          font-weight: 850;
        }

        .grid {
          min-height: 0;
          display: grid;
          grid-template-columns: 340px minmax(540px, 1fr) 340px;
          gap: 14px;
          align-items: start;
        }

        .col {
          min-height: 0;
        }
        .colLeft {
          overflow: auto;
          padding-right: 4px;
        }
        .colRight {
          overflow: auto;
          padding-left: 4px;
        }
        .colCenter {
          overflow: visible;
        }

        .stack {
          display: grid;
          gap: 14px;
        }

        .card {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 16px;
          box-shadow: var(--shadowSm);
          overflow: hidden;
        }
        .cardHead {
          width: 100%;
          border: 0;
          background: transparent;
          cursor: pointer;
          padding: 12px 14px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .cardHeadLeft {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .badge {
          width: 30px;
          height: 30px;
          border-radius: 999px;
          background: #eaf7ee;
          border: 1px solid #cfead8;
          display: grid;
          place-items: center;
        }
        .cardTitle {
          font-size: 14px;
          font-weight: 950;
        }
        .cardHeadRight {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .chev {
          color: var(--muted);
          font-weight: 950;
        }
        .cardBody {
          padding: 0 14px 14px 14px;
        }

        .label {
          font-size: 12px;
          color: var(--muted);
          font-weight: 850;
          margin-bottom: 6px;
        }

        .field {
          display: grid;
          gap: 6px;
        }
        .form {
          display: grid;
          gap: 12px;
        }
        .two {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }

        .input {
          width: 100%;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid var(--border);
          background: #fff;
          font-weight: 900;
          color: var(--text);
          outline: none;
        }

        .segWrap {
          display: grid;
          gap: 6px;
        }
        .seg {
          background: #f2f4f7;
          border: 1px solid #eef0f3;
          padding: 4px;
          border-radius: 999px;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
        }
        .segCompact {
          padding: 3px;
          gap: 5px;
        }
        .segBtn {
          border: 0;
          border-radius: 999px;
          padding: 8px 10px;
          background: transparent;
          cursor: pointer;
          font-weight: 900;
          color: var(--text);
          font-size: 13px;
        }
        .segCompact .segBtn {
          padding: 7px 9px;
          font-size: 12.5px;
        }
        .segBtnActive {
          background: #0b1220;
          color: #fff;
          box-shadow: 0 4px 10px rgba(16, 24, 40, 0.18);
        }
        .miniSeg .segBtn {
          padding: 7px 10px;
          font-size: 13px;
        }

        .dateWrap {
          position: relative;
          display: grid;
          gap: 6px;
        }
        .dateBtn {
          width: 100%;
          text-align: left;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid var(--border);
          background: #fff;
          font-weight: 900;
          color: var(--text);
          cursor: pointer;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
        }
        .muted {
          color: var(--muted);
          font-weight: 900;
        }

        .datePop {
          position: fixed;
          z-index: 9999;
          background: #fff;
          border: 1px solid var(--border);
          border-radius: 16px;
          box-shadow: 0 18px 40px rgba(16, 24, 40, 0.14);
          padding: 14px;
        }
        .dateTop {
          display: grid;
          grid-template-columns: 34px 1fr 34px;
          align-items: center;
          gap: 8px;
        }
        .miniBtn {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          border: 1px solid #eef0f3;
          background: #f9fafb;
          cursor: pointer;
          font-weight: 950;
        }
        .dateMonth {
          text-align: center;
          font-weight: 950;
        }
        .dateYearRow {
          display: flex;
          justify-content: center;
          margin-top: 8px;
        }
        .miniSelect {
          border: 1px solid #eef0f3;
          border-radius: 10px;
          padding: 8px 10px;
          background: #fff;
          font-weight: 950;
        }
        .dateGridHead {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 6px;
          margin-top: 12px;
        }
        .dateWd {
          text-align: center;
          font-size: 12px;
          color: #344054;
          font-weight: 900;
        }
        .dateGrid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 6px;
          margin-top: 8px;
        }
        .dateCell {
          height: 36px;
          border-radius: 999px;
          border: 1px solid transparent;
          background: transparent;
          cursor: pointer;
          font-weight: 900;
          color: var(--text);
        }
        .dateCellDim {
          color: #98a2b3;
        }
        .dateCellSel {
          background: var(--green);
          color: #fff;
          font-weight: 950;
        }

        .centerCard {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 16px;
          box-shadow: var(--shadow);
          padding: 14px;
        }
        .centerHead {
          display: grid;
          gap: 12px;
        }
        .centerTitle {
          font-size: 14px;
          font-weight: 950;
        }
        .controls {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr 220px;
          gap: 12px;
          align-items: end;
        }
        .ctrl {
          display: grid;
          gap: 8px;
        }
        .ctrlTop {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          font-size: 12px;
          color: #344054;
          font-weight: 850;
        }
        .pill {
          background: #f2f4f7;
          border: 1px solid #eef0f3;
          padding: 6px 10px;
          border-radius: 999px;
          font-weight: 950;
          color: var(--text);
        }
        .range {
          width: 100%;
        }
        .toggleCtrl {
          align-items: stretch;
        }
        .centerBody {
          margin-top: 8px;
        }

        .hintBox {
          margin: 10px 0 12px 0;
          background: #fff7ed;
          border: 1px solid #fde7c7;
          color: #7c2d12;
          padding: 10px 12px;
          border-radius: 14px;
          font-weight: 850;
          font-size: 12.5px;
        }

        .chartBox {
          border: 1px solid var(--border);
          border-radius: 16px;
          background: #fff;
          position: relative;
          overflow: hidden;
          padding: 14px;
        }
        .chartGrid {
          position: absolute;
          left: 14px;
          right: 14px;
          border-top: 1px dashed #eef0f3;
          pointer-events: none;
        }
        .chartScroll {
          height: 100%;
          overflow-x: auto;
          overflow-y: hidden;
          padding-bottom: 6px;
        }
        .chartScroll.chartNoX {
          overflow-x: hidden;
        }
        .chartCols {
          height: 100%;
          display: grid;
          align-items: end;
        }
        .barCol {
          display: grid;
          gap: 10px;
          align-items: end;
        }
        .barStackWrap {
          display: flex;
          align-items: flex-end;
          justify-content: center;
        }
        .barStack {
          width: 100%;
          border-radius: 14px;
          overflow: hidden;
          border: 1px solid #eef0f3;
          background: #f9fafb;
          display: flex;
          flex-direction: column;
          justify-content: flex-end;
        }
        .barSeg {
          display: flex;
          align-items: center;
          justify-content: center;
          color: #fff;
          font-weight: 950;
          text-align: center;
          padding: 0 10px;
        }
        .barSegText {
          line-height: 1.05;
          font-size: 12px;
        }
        .barSegLabel {
          opacity: 0.95;
        }
        .barSegVal {
          margin-top: 4px;
        }
        .barTitle {
          text-align: center;
          font-size: 13px;
          font-weight: 950;
          color: var(--text);
        }

        .totalPillWrap {
          display: flex;
          justify-content: center;
          margin-top: 18px;
        }
        .totalPill {
          background: #eaf7ee;
          border: 1px solid #bfe6cf;
          color: #0a6b2b;
          padding: 10px 14px;
          border-radius: 999px;
          font-weight: 950;
          box-shadow: var(--shadowSm);
        }

        .rightHeadVal {
          font-weight: 950;
        }
        .rightHeadVal.green {
          color: var(--green);
        }
        .bigNumber {
          font-size: 28px;
          font-weight: 950;
          letter-spacing: -0.02em;
        }
        .bigNumber.green {
          color: var(--green);
        }

        .rightBlock {
          display: grid;
          gap: 12px;
        }
        .twoMini {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        .miniCard {
          border-radius: 14px;
          padding: 12px;
          border: 1px solid #eef0f3;
          background: #fff;
        }
        .miniCard.warn {
          background: #fff7ed;
          border-color: #fde7c7;
        }
        .miniCard.danger {
          background: #fff1f2;
          border-color: #fecdd3;
        }
        .miniTop {
          font-size: 12px;
          font-weight: 950;
          color: #344054;
        }
        .miniVal {
          margin-top: 6px;
          font-size: 14px;
          font-weight: 950;
        }

        .barRow {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
        }
        .mutedSm {
          font-size: 12px;
          color: var(--muted);
          font-weight: 850;
        }
        .bold {
          font-weight: 950;
        }

        .progress {
          height: 10px;
          border-radius: 999px;
          background: #eef0f3;
          overflow: hidden;
        }
        .progressIn {
          height: 100%;
          background: var(--green);
        }
        .divider {
          height: 1px;
          background: #eef0f3;
          margin: 8px 0;
        }

        .kv {
          display: grid;
          gap: 8px;
        }
        .kvTitle {
          font-size: 12px;
          color: var(--muted);
          font-weight: 950;
          margin-top: 4px;
        }
        .kvTitle.mt {
          margin-top: 10px;
        }
        .kvRow {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          font-size: 13px;
          color: #344054;
          font-weight: 850;
        }
        .kvRow .bold {
          color: var(--text);
        }

        .error {
          color: #b00020;
          font-weight: 950;
        }

        /* ===== Lead Video CTA (Mobile only) ===== */
        .leadWrap {
          padding-bottom: 24px;
        }
        .leadCard {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 16px;
          box-shadow: var(--shadowSm);
          padding: 14px;
          display: grid;
          gap: 12px;
        }
        .leadTitle {
          font-size: 13px;
          font-weight: 950;
          color: var(--text);
        }
        .leadVideo {
          border: 1px solid var(--border);
          border-radius: 18px;
          overflow: hidden;
          background: #000;
          box-shadow: var(--shadowSm);
          max-height: 78vh;
        }
        .leadIframe {
          width: 100%;
          aspect-ratio: 9 / 16;
          border: 0;
          display: block;
          background: #000;
        }
        .leadBtn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          padding: 14px 14px;
          border-radius: 14px;
          background: #0b1220;
          color: #fff;
          text-decoration: none;
          font-weight: 950;
          letter-spacing: -0.01em;
          box-shadow: 0 8px 16px rgba(16, 24, 40, 0.16);
          border: 1px solid rgba(255, 255, 255, 0.08);
          transition: transform 0.12s ease, opacity 0.12s ease;
          user-select: none;
          -webkit-tap-highlight-color: transparent;
        }
        .leadBtn:active {
          transform: translateY(1px);
          opacity: 0.92;
        }

        @media (max-width: 980px) {
          .page {
            height: auto;
            min-height: 100vh;
            overflow: auto;
            padding: 12px;
          }
          .wrap {
            height: auto;
            grid-template-rows: 52px auto;
          }
          .controls {
            grid-template-columns: 1fr;
            gap: 10px;
          }

          .mobileFlow {
            display: grid;
            gap: 12px;
            padding-bottom: 12px;
          }

          .cardHead {
            padding: 10px 12px;
          }
          .cardBody {
            padding: 0 12px 12px 12px;
          }
          .input {
            padding: 9px 11px;
            border-radius: 12px;
          }
          .segBtn {
            padding: 7px 9px;
            font-size: 12.5px;
          }
          .segCompact .segBtn {
            padding: 6px 8px;
            font-size: 12px;
          }

          .centerCard {
            padding: 12px;
          }
          .chartBox {
            padding: 12px;
          }

          .barSegText {
            font-size: 11px;
          }
          .barTitle {
            font-size: 12px;
          }

          .leadWrap {
            margin-top: 6px;
          }
        }
      `}</style>
    </main>
  );
}
