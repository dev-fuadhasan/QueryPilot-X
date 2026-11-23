"use client";

import React, { useState } from "react";
import {
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Info,
  X,
  Copy,
  Check,
  Terminal,
  Activity,
  ArrowRight,
  Database,
  Calendar,
  UserCheck
} from "lucide-react";
import type { ChangeNotification } from "../types";

interface IncidentForensicModalProps {
  incident: ChangeNotification | null;
  onClose: () => void;
}

export default function IncidentForensicModal({ incident, onClose }: IncidentForensicModalProps) {
  const [copied, setCopied] = useState(false);

  if (!incident) return null;

  const assessment = incident.riskAssessment || {
    score: incident.riskScore || 15,
    severity: incident.riskSeverity || "LOW",
    factors: [],
    recommendation: "Routine database modification. Standard operational monitoring applies."
  };

  const copyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(incident, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const severityColors = {
    CRITICAL: { bg: "#fef2f2", text: "#b91c1c", border: "#fecaca", badge: "#dc2626", icon: ShieldAlert },
    HIGH: { bg: "#fff7ed", text: "#c2410c", border: "#fed7aa", badge: "#ea580c", icon: AlertTriangle },
    MEDIUM: { bg: "#fefce8", text: "#a16207", border: "#fef08a", badge: "#ca8a04", icon: Activity },
    LOW: { bg: "#f0fdf4", text: "#15803d", border: "#bbf7d0", badge: "#16a34a", icon: ShieldCheck }
  };

  const theme = severityColors[assessment.severity] || severityColors.LOW;
  const SeverityIcon = theme.icon;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "20px"
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "680px",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
          border: "1px solid #e2e8f0",
          display: "flex",
          flexDirection: "column"
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* MODAL HEADER */}
        <div
          style={{
            padding: "18px 24px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#f8fafc"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "10px",
                background: theme.bg,
                color: theme.badge,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: `1px solid ${theme.border}`
              }}
            >
              <SeverityIcon size={20} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
                Incident Forensic Investigation
              </h3>
              <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
                Deep-dive anomaly risk evaluation and root cause telemetry
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: 0,
              color: "#94a3b8",
              cursor: "pointer",
              padding: "4px",
              borderRadius: "6px"
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* MODAL BODY */}
        <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
          
          {/* RISK SCORE CARD */}
          <div
            style={{
              background: theme.bg,
              border: `1px solid ${theme.border}`,
              borderRadius: "12px",
              padding: "18px 20px"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", fontWeight: 700, color: theme.text, textTransform: "uppercase" }}>
                  Risk Classification
                </span>
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 800,
                    padding: "3px 8px",
                    borderRadius: "6px",
                    background: theme.badge,
                    color: "#ffffff"
                  }}
                >
                  {assessment.severity}
                </span>
              </div>
              <div style={{ fontSize: "20px", fontWeight: 800, color: theme.badge }}>
                {assessment.score} <span style={{ fontSize: "12px", color: theme.text }}>/ 100</span>
              </div>
            </div>

            {/* Score Bar */}
            <div
              style={{
                width: "100%",
                height: "8px",
                borderRadius: "4px",
                background: "#e2e8f0",
                overflow: "hidden"
              }}
            >
              <div
                style={{
                  width: `${assessment.score}%`,
                  height: "100%",
                  background: theme.badge,
                  borderRadius: "4px",
                  transition: "width 0.4s ease"
                }}
              />
            </div>

            {/* Recommendation */}
            <div style={{ marginTop: "14px", display: "flex", gap: "8px", alignItems: "flex-start" }}>
              <Info size={16} style={{ color: theme.badge, flexShrink: 0, marginTop: "2px" }} />
              <p style={{ margin: 0, fontSize: "12px", color: theme.text, lineHeight: 1.5, fontWeight: 500 }}>
                {assessment.recommendation}
              </p>
            </div>
          </div>

          {/* TRIGGERED RISK FACTORS */}
          <div>
            <h4 style={{ margin: "0 0 10px", fontSize: "13px", fontWeight: 700, color: "#1e293b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Triggered Risk Factors ({assessment.factors.length})
            </h4>
            {assessment.factors.length === 0 ? (
              <p style={{ fontSize: "12px", color: "#64748b", margin: 0, padding: "10px 14px", background: "#f8fafc", borderRadius: "8px" }}>
                No anomalous or hazardous conditions detected for this change.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {assessment.factors.map((f, idx) => (
                  <div
                    key={idx}
                    style={{
                      background: "#ffffff",
                      border: "1px solid #e2e8f0",
                      borderRadius: "8px",
                      padding: "10px 14px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "12px"
                    }}
                  >
                    <div>
                      <strong style={{ fontSize: "12px", color: "#0f172a", display: "block" }}>
                        {f.factor}
                      </strong>
                      <span style={{ fontSize: "11px", color: "#64748b" }}>
                        {f.description}
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: "12px",
                        background: "#fee2e2",
                        color: "#991b1b",
                        whiteSpace: "nowrap"
                      }}
                    >
                      +{f.weight} pts
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* RECORD DIFF PREVIEW */}
          <div>
            <h4 style={{ margin: "0 0 10px", fontSize: "13px", fontWeight: 700, color: "#1e293b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Modified Payload
            </h4>
            <div
              style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "14px 18px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "16px",
                flexWrap: "wrap"
              }}
            >
              <div>
                <span style={{ fontSize: "10px", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>Target Column</span>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>{incident.columnName}</div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                <div>
                  <span style={{ fontSize: "10px", color: "#94a3b8", fontWeight: 700 }}>OLD</span>
                  <div style={{ fontFamily: "monospace", fontSize: "12px", color: "#dc2626", textDecoration: "line-through" }}>
                    {String(incident.oldValue)}
                  </div>
                </div>
                <ArrowRight size={14} style={{ color: "#94a3b8" }} />
                <div>
                  <span style={{ fontSize: "10px", color: "#94a3b8", fontWeight: 700 }}>NEW</span>
                  <div style={{ fontFamily: "monospace", fontSize: "12px", color: "#16a34a", fontWeight: 700 }}>
                    {String(incident.newValue)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* METADATA SPECIFICATIONS */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: "10px",
              background: "#f1f5f9",
              padding: "12px 16px",
              borderRadius: "8px",
              fontSize: "11px",
              color: "#475569"
            }}
          >
            <div>
              <strong>Table:</strong> {incident.tableName}
            </div>
            <div>
              <strong>Record ID:</strong> #{incident.recordId}
            </div>
            <div>
              <strong>Actor / Source:</strong> {incident.changedBy || "Database Editor"}
            </div>
            <div>
              <strong>Timestamp:</strong> {incident.timestamp}
            </div>
          </div>
        </div>

        {/* MODAL FOOTER */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
          }}
        >
          <button
            onClick={copyJson}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: "8px",
              padding: "8px 14px",
              fontSize: "12px",
              fontWeight: 600,
              color: "#334155",
              cursor: "pointer"
            }}
          >
            {copied ? <Check size={14} color="#16a34a" /> : <Copy size={14} />}
            {copied ? "Incident JSON Copied!" : "Export Incident JSON"}
          </button>

          <button
            onClick={onClose}
            style={{
              background: "#0f172a",
              color: "#ffffff",
              border: 0,
              borderRadius: "8px",
              padding: "8px 18px",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer"
            }}
          >
            Close Investigation
          </button>
        </div>
      </div>
    </div>
  );
}
