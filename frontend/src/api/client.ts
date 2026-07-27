import type { Analysis, AnalysisStatus } from '../types/message';

const API_BASE = 'http://localhost:8000';

export interface PingResponse {
  echo: string;
  received_at: string;
}

export interface CreatedMessage {
  id: string;
  content: string;
  sender: string;
  created_at: string;
  analysis_status: AnalysisStatus;
}

export async function sendPing(text: string): Promise<PingResponse> {
  const response = await fetch(`${API_BASE}/ping`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error(`Ping request failed: ${response.status}`);
  }

  return response.json();
}

/** Persist a message. Returns as soon as the row is written; analysis is not waited on. */
export async function createMessage(content: string): Promise<CreatedMessage> {
  const response = await fetch(`${API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    throw new Error(`Create message failed: ${response.status}`);
  }

  return response.json();
}

export async function getAnalysis(messageId: string): Promise<Analysis> {
  const response = await fetch(`${API_BASE}/messages/${messageId}/analysis`);

  if (!response.ok) {
    throw new Error(`Analysis fetch failed: ${response.status}`);
  }

  return response.json();
}
