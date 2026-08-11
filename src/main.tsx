import React from "react";
import { createRoot } from "react-dom/client";
import "../app/globals.css";
import "../app/mobile-overrides.css";
import { WarehouseApp } from "../app/warehouse-app";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WarehouseApp />
  </React.StrictMode>
);