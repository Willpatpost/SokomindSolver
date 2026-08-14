import { Component, type ErrorInfo, type ReactNode } from "react";
import { resetAppData } from "../app-data-reset";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Sokomind caught an unrecoverable rendering error:", error, info);
  }

  #hardNavigate = () => {
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.set("_r", Date.now().toString(36));
    window.location.replace(url.href);
  };

  #handleReload = () => {
    this.#hardNavigate();
  };

  #handleReset = async () => {
    const confirmed = window.confirm(
      "Reset Sokomind's saved progress, current attempt, timers, and preferences? This cannot be undone.",
    );
    if (!confirmed) return;

    try {
      await resetAppData();
      this.#hardNavigate();
    } catch (error) {
      console.error("Sokomind could not completely reset saved data:", error);
      window.alert(
        "Sokomind could not clear all browser data. The page was not reloaded because some saved data may remain.",
      );
    }
  };

  override render() {
    if (!this.state.error) return this.props.children;

    const isOffline = typeof navigator !== "undefined" && !navigator.onLine;
    const isLazyLoadFailure = /chunk|dynamically imported|module script|importing a module/iu.test(
      this.state.error.message,
    );
    const recoveryMessage = isOffline
      ? "Sokomind could not load this screen while offline. Reconnect, then retry; your saved progress will stay intact."
      : isLazyLoadFailure
        ? "A screen file did not load. This can happen after an update or a dropped connection. Retry before resetting anything."
        : "Sokomind hit an unexpected error. Try reloading first; your saved progress will stay intact.";

    return (
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          padding: "2rem",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          color: "var(--ink-950)",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.75rem" }}>
          Something went wrong
        </h1>
        <p style={{ maxWidth: "28rem", marginBottom: "1.5rem", color: "var(--ink-muted)" }}>
          {recoveryMessage}
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: "0.75rem",
          }}
        >
          <button
            onClick={this.#handleReload}
            type="button"
            style={{
              padding: "0.625rem 1.5rem",
              fontSize: "0.9375rem",
              fontWeight: 600,
              color: "var(--paper-50)",
              background: "var(--coral-500)",
              border: "none",
              borderRadius: "10px",
              cursor: "pointer",
            }}
          >
            Retry loading
          </button>
          <button
            onClick={this.#handleReset}
            type="button"
            style={{
              padding: "0.625rem 1.5rem",
              fontSize: "0.9375rem",
              fontWeight: 600,
              color: "var(--ink-950)",
              background: "transparent",
              border: "1px solid var(--ink-muted)",
              borderRadius: "10px",
              cursor: "pointer",
            }}
          >
            Reset saved data
          </button>
        </div>
        <details
          style={{
            marginTop: "2rem",
            maxWidth: "32rem",
            textAlign: "left",
            color: "var(--ink-muted)",
            fontSize: "0.8125rem",
          }}
        >
          <summary style={{ cursor: "pointer" }}>Error details</summary>
          <pre
            style={{
              marginTop: "0.5rem",
              padding: "0.75rem",
              background: "var(--paper-100)",
              borderRadius: "8px",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {this.state.error.message}
            {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
          </pre>
        </details>
      </div>
    );
  }
}
