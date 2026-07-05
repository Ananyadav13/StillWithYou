import { useCallback, useState } from 'react';
import { sendPing } from '../api/client';
import type { Message } from '../types/message';

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) {
      return;
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      content: text,
      sender: 'user',
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsSending(true);

    try {
      const response = await sendPing(text);
      console.log('Ping response:', response);
    } catch (error) {
      console.error('Ping failed:', error);
    } finally {
      setIsSending(false);
    }
  }, []);

  return {
    messages,
    input,
    setInput,
    isSending,
    sendMessage,
  };
}
