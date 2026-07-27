export type MessageSender = 'user' | 'assistant';

export type AnalysisStatus = 'pending' | 'complete' | 'failed';

/** Wire shape of GET /messages/{id}/analysis. */
export interface Analysis {
  message_id: string;
  analysis_status: AnalysisStatus;
  mood: string | null;
  toxicity_score: number | null;
  heat_score: number | null;
  rewrite_suggestion: string | null;
}

export interface Message {
  id: string;
  content: string;
  sender: MessageSender;
  timestamp: string;
  analysisStatus?: AnalysisStatus;
  mood?: string | null;
  toxicityScore?: number | null;
  heatScore?: number | null;
  rewriteSuggestion?: string | null;
}
