export type MessageSender = 'user' | 'assistant';

export interface Message {
  id: string;
  content: string;
  sender: MessageSender;
  timestamp: string;
  moodScore?: number;
  toxicityFlag?: boolean;
  rewriteSuggestion?: string;
}
