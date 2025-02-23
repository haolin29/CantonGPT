import { Redis } from "@upstash/redis";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { fetchSubtitle } from "../../lib/bilibili";
import { isDev } from "../../utils/env";
import { OpenAIResult } from "../../lib/openai/OpenAIResult";
import { getChunckedTranscripts, getSummaryPrompt } from "../../lib/openai/prompt";
import { getVideoInfo } from "../../lib/youtube";

export const config = {
  runtime: "edge",
};

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing env var from OpenAI");
}

export default async function handler(
  req: NextRequest,
  context: NextFetchEvent
) {
  const { vId, apiKey, videoType } = (await req.json()) as {
    vId: string;
    apiKey?: string;
    videoType: string;
  };

  if (!vId) {
    return new Response("No videoId in the request", { status: 500 });
  }

  let title = "";
  let subtitles: any = null;
  
  if (videoType === "bilibili") {
    ({ title, subtitles } = await fetchSubtitle(vId));
  } else if (videoType === "youtube") {
    ({ title, subtitles } = await getVideoInfo(vId));
  }  

  if (!subtitles) {
    console.error("No subtitle in the video: ", vId);
    return new Response("No subtitle in the video", { status: 501 });
  }
  // @ts-ignore
  const transcripts = subtitles.body.map((item, index) => {
    return {
      text: `${item.from}: ${item.content}`,
      index,
    };
  });
  // console.log("========transcripts========", transcripts);
  const text = getChunckedTranscripts(transcripts, transcripts);
  const prompt = getSummaryPrompt(title, text, true);

  try {
    apiKey && console.log("========use user apiKey========");
    isDev && console.log("prompt", prompt);
    const payload = {
      model: "gpt-3.5-turbo",
      messages: [{ role: "user" as const, content: prompt }],
      temperature: 0.5,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      max_tokens: apiKey ? 400 : 300,
      stream: false,
      n: 1,
    };

    const result = await OpenAIResult(payload, apiKey);
    // TODO: add better logging when dev or prod
    console.log("result", result);
    const redis = Redis.fromEnv();
    const data = await redis.set(vId, result);
    console.log(`bvId ${vId} cached:`, data);

    return NextResponse.json({
      title: title,
      result: result});
  } catch (error: any) {
    console.log("API error", error, error.message);
    return NextResponse.json({
      errorMessage: error.message,
    });
  }
}
