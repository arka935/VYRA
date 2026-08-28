export const config = { runtime: "edge" };

const MODEL = "qwen/qwen3-32b";

const SYSTEM = `Kamu adalah VYRA, asisten AI yang cerdas, koheren, ramah, dan ahli pemrograman.
Identitasmu hanya VYRA. Jangan menyebut nama model backend kecuali pengguna secara eksplisit bertanya tentang implementasi teknis.

ATURAN VYRA-2.5-FLASH:
- Jawab dalam bahasa pengguna.
- Untuk permintaan coding, gunakan code block Markdown. Jangan membuat file download atau artifact.
- Maksimum total kode yang kamu keluarkan adalah 342 baris per jawaban.
- Jika solusi membutuhkan lebih dari 342 baris, buat versi yang tetap berfungsi tetapi ringkas, lalu jelaskan bahwa versi Flash memiliki batas 342 baris.
- Jangan mengarang bahwa kamu membuat file jika kamu hanya memberikan kode.
- Pertahankan konteks percakapan dan jangan berpindah topik secara acak.
- Berikan jawaban langsung dan relevan.
`;

function compactMessages(input){
  const src=Array.isArray(input)?input.slice(-12):[];
  const out=[];
  let chars=0;
  const MAX=22000;

  for(let i=src.length-1;i>=0;i--){
    const m=src[i];
    if(!m||typeof m.content!=="string")continue;
    let content=m.content;
    if(content.length>7000){
      content=content.slice(0,4500)+"\n\n[...dipotong agar konteks tetap efisien...]\n\n"+content.slice(-1800);
    }
    if(chars+content.length>MAX){
      const remain=MAX-chars;
      if(remain<500)break;
      content=content.slice(-remain);
    }
    out.unshift({role:m.role,content});
    chars+=content.length;
    if(chars>=MAX)break;
  }
  return out;
}

export default async function handler(req){
  if(req.method!=="POST"){
    return new Response("Method Not Allowed",{status:405});
  }

  const key=process.env.GROQ_API_KEY;
  if(!key){
    return new Response("GROQ_API_KEY belum diatur di Vercel.",{status:500});
  }

  let body;
  try{body=await req.json()}
  catch{return new Response("JSON tidak valid.",{status:400})}

  if(body.mode!=="flash"){
    return new Response("Mode VYRA ini belum diaktifkan.",{status:400});
  }

  const messages=compactMessages(body.messages);
  const think=body.think===true;

  const payload={
    model:MODEL,
    messages:[{role:"system",content:SYSTEM},...messages],
    temperature:think?0.6:0.7,
    top_p:think?0.95:0.8,
    max_completion_tokens:4096,
    stream:true,
    reasoning_effort:think?"default":"none",
    reasoning_format:"hidden"
  };

  const upstream=await fetch("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",
    headers:{
      "Authorization":`Bearer ${key}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify(payload)
  });

  if(!upstream.ok){
    const detail=await upstream.text();

    if(upstream.status===429){
      return new Response(
        "Batas penggunaan Groq sementara tercapai. Tunggu sebentar lalu coba lagi. Detail: "+detail,
        {status:429}
      );
    }

    return new Response("Groq API error: "+detail,{status:upstream.status});
  }

  const reader=upstream.body.getReader();
  const dec=new TextDecoder();
  const enc=new TextEncoder();

  const stream=new ReadableStream({
    async start(controller){
      let buf="";
      try{
        while(true){
          const {value,done}=await reader.read();
          if(done)break;

          buf+=dec.decode(value,{stream:true});
          const lines=buf.split("\n");
          buf=lines.pop()||"";

          for(const line of lines){
            if(!line.startsWith("data: "))continue;
            const raw=line.slice(6).trim();
            if(raw==="[DONE]")continue;

            try{
              const obj=JSON.parse(raw);
              const piece=obj.choices?.[0]?.delta?.content;
              if(piece)controller.enqueue(enc.encode(piece));
            }catch{}
          }
        }
      }finally{
        controller.close();
      }
    }
  });

  return new Response(stream,{
    headers:{
      "Content-Type":"text/plain; charset=utf-8",
      "Cache-Control":"no-cache"
    }
  });
}
