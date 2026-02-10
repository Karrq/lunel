// AI types mirroring OpenCode SDK types for mobile-side usage

export interface AIEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface AISession {
  id: string;
  title: string;
  time: { created: number; updated: number };
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface AIAgent {
  name: string;
  description?: string;
  mode: string;
}

export interface AIModel {
  id: string;
  name: string;
  provider: string;
}

export interface AIProvider {
  id: string;
  name: string;
  models: Record<string, AIModel>;
}

export interface AIPart {
  type: string;
  [key: string]: unknown;
}

export interface AIMessage {
  id: string;
  role: "user" | "assistant";
  parts: AIPart[];
  metadata?: Record<string, unknown>;
  time?: { created: number; updated: number };
}

export interface AIPermission {
  id: string;
  type: string;
  title: string;
  metadata: Record<string, unknown>;
}
