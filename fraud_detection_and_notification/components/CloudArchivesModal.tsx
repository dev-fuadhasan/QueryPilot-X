"use client";

import React, { useState, useEffect } from "react";
import {
  Cloud,
  Download,
  Trash2,
  RefreshCw,
  X,
  FileText,
  CheckCircle,
  AlertCircle,
  ExternalLink,
  ShieldCheck
} from "lucide-react";

interface CloudFile {
  name: string;
  storageKey: string;
  size: number;
  createdAt: string;
  category: string;
}

interface CloudArchivesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CloudArchivesModal({ isOpen, onClose }: CloudArchivesModalProps) {
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const fetchArchives = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/storage/list?category=reports");
      const data = await res.json();
      if (data.success && Array.isArray(data.files)) {
        setFiles(data.files);
      } else {
        setError(data.error || "Unable to list archived reports from Supabase Storage.");
      }
    } catch {
      setError("Failed to connect to storage service.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void fetchArchives();
    }
  }, [isOpen]);

  const handleDownload = async (storageKey: string) => {
    setDownloadingKey(storageKey);
    try {
      const res = await fetch(`/api/storage/download?storageKey=${encodeURIComponent(storageKey)}`);
      const data = await res.json();
      if (data.success && data.signedUrl) {
        window.open(data.signedUrl, "_blank");
      } else {
        alert(data.error || "Failed to generate signed download URL.");
      }
    } catch {
      alert("Error initiating signed download.");
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleDelete = async (storageKey: string) => {
    if (!confirm("Are you sure you want to permanently delete this archived report from Supabase Storage?")) {
      return;
    }
    setDeletingKey(storageKey);
    try {
      const res = await fetch("/api/storage/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageKey })
      });
      const data = await res.json();
      if (data.success) {
        setFiles((prev) => prev.filter((f) => f.storageKey !== storageKey));
      } else {
        alert(data.error || "Deletion failed.");
      }
    } catch {
      alert("Error deleting storage object.");
    } finally {
      setDeletingKey(null);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  if (!isOpen) return null;

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
          maxWidth: "720px",
          maxHeight: "85vh",
          overflowY: "auto",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1)",
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
            background: "#f8fafc"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "10px",
                background: "#eff6ff",
                color: "#2563eb",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "1px solid #bfdbfe"
              }}
            >
              <Cloud size={20} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
                Supabase Cloud Storage Archives
              </h3>
              <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
                Private bucket: <code style={{ color: "#2563eb", fontWeight: 600 }}>querypilotx-storage/reports</code>
              </p>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              onClick={fetchArchives}
              disabled={loading}
              style={{
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                padding: "6px 10px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "12px",
                color: "#475569"
              }}
              title="Refresh list"
            >
              <RefreshCw size={12} className={loading ? "spinning" : ""} /> Refresh
            </button>
            <button
              onClick={onClose}
              style={{
                background: "transparent",
                border: 0,
                color: "#94a3b8",
                cursor: "pointer",
                padding: "4px"
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* BODY */}
        <div style={{ padding: "24px" }}>
          {error && (
            <div
              style={{
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#b91c1c",
                borderRadius: "8px",
                padding: "10px 14px",
                fontSize: "12px",
                marginBottom: "16px",
                display: "flex",
                alignItems: "center",
                gap: "8px"
              }}
            >
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div style={{ textAlign: "center", padding: "40px 20px", color: "#64748b" }}>
              <RefreshCw size={24} className="spinning" style={{ margin: "0 auto 10px" }} />
              <p style={{ margin: 0, fontSize: "13px" }}>Querying Supabase Storage bucket objects...</p>
            </div>
          ) : files.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 20px", background: "#f8fafc", borderRadius: "12px", border: "1px dashed #cbd5e1" }}>
              <ShieldCheck size={32} style={{ color: "#94a3b8", margin: "0 auto 10px" }} />
              <h4 style={{ margin: "0 0 6px", fontSize: "14px", color: "#1e293b" }}>No Cloud Archives Found</h4>
              <p style={{ margin: 0, fontSize: "12px", color: "#64748b", maxWidth: "400px", marginLeft: "auto", marginRight: "auto" }}>
                You have not archived any fraud incident reports to Supabase Storage yet. Click &quot;Archive to Cloud&quot; on the dashboard toolbar to create your first encrypted report.
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {files.map((file) => (
                <div
                  key={file.storageKey}
                  style={{
                    background: "#ffffff",
                    border: "1px solid #e2e8f0",
                    borderRadius: "10px",
                    padding: "14px 18px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px"
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
                    <div
                      style={{
                        width: "36px",
                        height: "36px",
                        borderRadius: "8px",
                        background: "#f1f5f9",
                        color: "#0f172a",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0
                      }}
                    >
                      <FileText size={18} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: "13px",
                          fontWeight: 700,
                          color: "#0f172a",
                          textOverflow: "ellipsis",
                          overflow: "hidden",
                          whiteSpace: "nowrap"
                        }}
                      >
                        {file.name}
                      </div>
                      <div style={{ fontSize: "11px", color: "#64748b", display: "flex", gap: "8px", alignItems: "center" }}>
                        <span>{formatBytes(file.size)}</span>
                        <span>•</span>
                        <span>{new Date(file.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                    <button
                      onClick={() => handleDownload(file.storageKey)}
                      disabled={downloadingKey === file.storageKey}
                      style={{
                        background: "#eff6ff",
                        border: "1px solid #bfdbfe",
                        borderRadius: "6px",
                        padding: "6px 12px",
                        fontSize: "12px",
                        fontWeight: 600,
                        color: "#1d4ed8",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px"
                      }}
                    >
                      <Download size={13} />
                      {downloadingKey === file.storageKey ? "Signing..." : "Signed Link"}
                    </button>

                    <button
                      onClick={() => handleDelete(file.storageKey)}
                      disabled={deletingKey === file.storageKey}
                      style={{
                        background: "#fff",
                        border: "1px solid #fecaca",
                        borderRadius: "6px",
                        padding: "6px 10px",
                        cursor: "pointer",
                        color: "#dc2626"
                      }}
                      title="Delete from cloud"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* FOOTER */}
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
          <span style={{ fontSize: "11px", color: "#64748b" }}>
            Total files: <strong>{files.length}</strong> | Server-side user namespace isolation active
          </span>
          <button
            onClick={onClose}
            style={{
              background: "#0f172a",
              color: "#ffffff",
              border: 0,
              borderRadius: "8px",
              padding: "8px 16px",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer"
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
