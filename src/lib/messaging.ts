import type { Message, MessageResponse } from './types';

export function sendMessage<M extends Message>(
  msg: M,
): Promise<MessageResponse<M['type']>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response as MessageResponse<M['type']>);
    });
  });
}
