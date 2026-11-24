"use client";

import React, { useState } from "react";
import {
  Flame,
  ShieldAlert,
  Zap,
  TrendingUp,
  KeyRound,
  DollarSign,
  X,
  Play,
  CheckCircle2,
  Sparkles
} from "lucide-react";
import type { ChangeNotification } from "../types";
import { evaluateChangeRisk } from "../risk-engine";

interface SimulationStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInjectIncident: (incident: ChangeNotification) => void;
}

interface Scenario {
  id: string;
  title: string;
  category: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  tableName: string;
  recordId: string;
  columnName: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string;
  description: string;
  icon: React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>;
}

const SIMULATION_SCENARIOS: Scenario[] = [
  {
    id: "priv_escalation",
    title: "Unauthorized Role Privilege Escalation",
    category: "Access & Security",
    severity: "CRITICAL",
    tableName: "users",
    recordId: "usr_88219",
    columnName: "role",
    oldValue: "member",
    newValue: "superuser_admin",
    changedBy: "API Session (Direct SQL)",
    description: "Standard tenant account elevated directly to superuser without organizational approval.",
    icon: KeyRound
  },
  {
    id: "negative_balance",
    title: "Monetary Inversion / Negative Balance Exploit",
    category: "Fintech & Ledger",
    severity: "CRITICAL",
    tableName: "wallets",
    recordId: "wlt_99014",
    columnName: "balance",
    oldValue: 1250.00,
    newValue: -450.00,
    changedBy: "Automated Micro-transfer Loop",
    description: "Account balance inverted into negative balance violating strict double-entry ledger constraints.",
    icon: DollarSign
  },
  {
    id: "magnitude_spike",
    title: "Extreme Price & Quantity Tampering (>850%)",
    category: "E-Commerce Fraud",
    severity: "HIGH",
    tableName: "orders",
    recordId: "ord_44109",
    columnName: "amount",
    oldValue: 85.00,
    newValue: 7450.00,
    changedBy: "Checkout Gateway Hack",
    description: "Order value spiked abruptly far beyond account historical baseline velocity.",
    icon: TrendingUp
  },
  {
    id: "credential_tamper",
    title: "Midnight Sensitive Credential Modification",
    category: "Audit & Compliance",
    severity: "HIGH",
    tableName: "accounts",
    recordId: "acc_11204",
    columnName: "password_hash",
    oldValue: "$2a$12$e8x...old",
    newValue: "$2a$12$q9z...tampered",
    changedBy: "External Actor (Suspicious IP)",
    description: "Critical authentication secret altered at 03:22 AM outside operational business windows.",
    icon: ShieldAlert
  }
];

export default function SimulationStudioModal({
  isOpen,
  onClose,
  onInjectIncident
}: SimulationStudioModalProps) {
  const [injectedId, setInjectedId] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleInject = (scenario: Scenario) => {
    const nowIso = new Date().toISOString();
    const risk = evaluateChangeRisk(
      scenario.tableName,
      scenario.columnName,
      scenario.oldValue,
      scenario.newValue,
      nowIso,
      "universal",
      "medium"
    );

    const syntheticIncident: ChangeNotification = {
      id: `sim_${scenario.id}_${Date.now()}`,
      tableName: scenario.tableName,
      recordId: scenario.recordId,
      columnName: scenario.columnName,
      oldValue: scenario.oldValue,
      newValue: scenario.newValue,
      changedBy: scenario.changedBy,
      timestamp: nowIso,
      changeType: "UPDATE",
      reason: `[SIMULATED INCIDENT] ${scenario.description}`,
      isRead: false,
      riskScore: risk.score,
      riskSeverity: risk.severity,
      riskAssessment: risk
    };

    onInjectIncident(syntheticIncident);
    setInjectedId(scenario.id);
    setTimeout(() => setInjectedId(null), 3000);
  };

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
          maxWidth: "700px",
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 25px 30px -5px rgba(0, 0, 0, 0.15)",
          border: "1px solid #e2e8f0",
          display: "flex",
          flexDirection: "column"
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* HEADER */}
        <div
          style={{
            padding: "18px 24px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#fff1f2"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "10px",
                background: "#fecdd3",
                color: "#e11d48",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "1px solid #fda4af"
              }}
            >
              <Flame size={20} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#881337" }}>
                Live Incident Simulation Studio
              </h3>
              <p style={{ margin: 0, fontSize: "12px", color: "#9f1239" }}>
                Test and demonstrate real-time anomaly detection, risk scoring, and forensic telemetry
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: 0,
              color: "#9f1239",
              cursor: "pointer",
              padding: "4px"
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* BODY */}
        <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "14px" }}>
          <div
            style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              padding: "12px 16px",
              fontSize: "12px",
              color: "#475569",
              display: "flex",
              alignItems: "center",
              gap: "8px"
            }}
          >
            <Sparkles size={16} color="#2563eb" flex-shrink={0} />
            <span>
              Click <strong>&quot;Inject Scenario&quot;</strong> to simulate live attacks or suspicious database mutations. The dashboard will instantly evaluate and categorize them in real-time.
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {SIMULATION_SCENARIOS.map((scenario) => {
              const Icon = scenario.icon;
              const isInjected = injectedId === scenario.id;

              return (
                <div
                  key={scenario.id}
                  style={{
                    background: "#ffffff",
                    border: "1px solid #e2e8f0",
                    borderRadius: "10px",
                    padding: "16px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "16px",
                    transition: "all 0.15s ease"
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", minWidth: 0 }}>
                    <div
                      style={{
                        width: "36px",
                        height: "36px",
                        borderRadius: "8px",
                        background: scenario.severity === "CRITICAL" ? "#fee2e2" : "#fef3c7",
                        color: scenario.severity === "CRITICAL" ? "#dc2626" : "#d97706",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0
                      }}
                    >
                      <Icon size={18} />
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
                        <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
                          {scenario.title}
                        </span>
                        <span
                          style={{
                            fontSize: "10px",
                            fontWeight: 800,
                            padding: "2px 6px",
                            borderRadius: "4px",
                            background: scenario.severity === "CRITICAL" ? "#fef2f2" : "#fffbeb",
                            color: scenario.severity === "CRITICAL" ? "#dc2626" : "#b45309",
                            border: `1px solid ${scenario.severity === "CRITICAL" ? "#fecaca" : "#fde68a"}`
                          }}
                        >
                          {scenario.severity}
                        </span>
                      </div>
                      <p style={{ margin: "0 0 6px", fontSize: "11px", color: "#64748b" }}>
                        {scenario.description}
                      </p>
                      <div style={{ fontSize: "10px", fontFamily: "monospace", color: "#475569", background: "#f1f5f9", padding: "3px 8px", borderRadius: "4px", display: "inline-block" }}>
                        {scenario.tableName}.{scenario.columnName}: {String(scenario.oldValue)} → {String(scenario.newValue)}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => handleInject(scenario)}
                    style={{
                      background: isInjected ? "#16a34a" : "#0f172a",
                      color: "#ffffff",
                      border: 0,
                      borderRadius: "8px",
                      padding: "8px 14px",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      flexShrink: 0,
                      transition: "background 0.2s ease"
                    }}
                  >
                    {isInjected ? <CheckCircle2 size={14} /> : <Zap size={14} />}
                    {isInjected ? "Injected!" : "Inject"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* FOOTER */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
            display: "flex",
            justifyContent: "flex-end"
          }}
        >
          <button
            onClick={onClose}
            style={{
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: "8px",
              padding: "8px 16px",
              fontSize: "12px",
              fontWeight: 600,
              color: "#334155",
              cursor: "pointer"
            }}
          >
            Close Studio
          </button>
        </div>
      </div>
    </div>
  );
}
