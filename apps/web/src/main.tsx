import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-ext-500.css";
import "@fontsource/inter/latin-ext-600.css";
import "@fontsource/inter/latin-ext-700.css";
import App from "./App";
import "./styles.css";
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="welcome">
        <h1>Nie udało się wyświetlić aplikacji.</h1>
        <p>Zapisany sejf pozostaje na urządzeniu.</p>
        <button onClick={() => location.reload()}>Wczytaj ponownie</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

import { prepareOffline } from "./offline";
void prepareOffline();
