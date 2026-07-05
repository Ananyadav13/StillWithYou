export interface PingResponse {
  echo: string;
  received_at: string;
}

export async function sendPing(text: string): Promise<PingResponse> {
  const response = await fetch('http://localhost:8000/ping', {
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
