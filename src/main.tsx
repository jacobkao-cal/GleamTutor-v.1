import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { withDemoFixture } from "./trace/tracer";
import { realTracer } from "./tracer/realTracer";
import "./styles.css";

// The exact square(5) demo keeps its predefined Demo trace; everything else is
// compiled and run for real inside the browser sandbox (src/tracer/browserRuntime.ts).
const tracer = withDemoFixture(realTracer);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App tracer={tracer} realTracing />
  </StrictMode>,
);
