import { createParser, ParsedEvent, ReconnectInterval } from "eventsource-parser";
import { checkOpenaiApiKeys } from "~/lib/openai/openai";
import { sample } from "../../utils/fp";

// TODO: maybe chat with video?
export type ChatGPTAgent = "user" | "system" | "assistant";

export interface ChatGPTMessage {
  role: ChatGPTAgent;
  content: string;
}
export interface OpenAIStreamPayload {
  api_key?: string;
  model: string;
  messages: ChatGPTMessage[];
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
  max_tokens: number;
  stream: boolean;
  n: number;
}

function formatResult(result: any) {
  const answer = result.choices[0].message?.content || "";
  if (answer.startsWith("\n\n")) {
    return answer.substring(2);
  }
  return answer;
}

function selectApiKey(apiKey: string | undefined) {
  if (apiKey && checkOpenaiApiKeys(apiKey)) {
    const userApiKeys = apiKey.split(",");
    return sample(userApiKeys);
  }

  // don't need to validate anymore, already verified in middleware?
  const myApiKeyList = process.env.OPENAI_API_KEY;
  const luckyApiKey = sample(myApiKeyList?.split(","));
  return luckyApiKey || "";
}

export async function OpenAIResult(
  payload: OpenAIStreamPayload,
  apiKey?: string
) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const openai_api_key = selectApiKey(apiKey);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openai_api_key ?? ""}`,
    },
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (res.status !== 200) {
    throw new Error("OpenAI API: " + res.statusText);
  }

  if (!payload.stream) {
    const result = await res.json();
    return formatResult(result);
  }

  let counter = 0;

  const stream = new ReadableStream({
    async start(controller) {
      // callback
      function onParse(event: ParsedEvent | ReconnectInterval) {
        if (event.type === "event") {
          const data = event.data;
          // https://beta.openai.com/docs/api-reference/completions/create#completions/create-stream
          if (data === "[DONE]") {
            controller.close();
            return;
          }
          try {
            const json = JSON.parse(data);
            const text = formatResult(json);
            console.log("=====text====", text);
            if (counter < 2 && (text.match(/\n/) || []).length) {
              // this is a prefix character (i.e., "\n\n"), do nothing
              return;
            }
            const queue = encoder.encode(text);
            controller.enqueue(queue);
            counter++;
          } catch (e) {
            // maybe parse error
            controller.error(e);
          }
        }
      }

      // stream response (SSE) from OpenAI may be fragmented into multiple chunks
      // this ensures we properly read chunks and invoke an event for each SSE event stream
      const parser = createParser(onParse);
      // https://web.dev/streams/#asynchronous-iteration
      for await (const chunk of res.body as any) {
        parser.feed(decoder.decode(chunk));
      }
    },
  });

  return stream;
}
