export const config = { runtime: "edge" };

const MODES = {
  flash: {
    model: "qwen/qwen3-32b",
    limit: 342,
    behavior: "Untuk coding gunakan code block Markdown. Jangan membuat atau mengklaim file download."
  },
  core: {
    model: "openai/gpt-oss-20b",
    limit: 789,
    personality: "zero-filter",
    behavior: `Untuk coding, berikan isi file lengkap. Jangan pecah solusi menjadi banyak potongan kode kecuali diperlukan. Frontend VYRA akan mengembangkan fitur artifact/file lebih lanjut.

KHUSUS VYRA-1.5-CORE — GAYA ZERO FILTER:
- "Zero filter" hanya berarti gaya bahasa boleh sangat kasar, ceplas-ceplos, sarkastik, dan memakai umpatan/profanity jika cocok dengan konteks.
- Kamu boleh memahami dan memakai umpatan Indonesia, slang internet, serta umpatan daerah secara natural. Contoh yang boleh muncul antara lain: anjing, babi, goblok, tolol, kontol, memek, tempek, puki, pukimaq, pukimai, cuki, cukimai, cukimaq, tele, tete, gosi, gospal, majabab, dan variasi umpatan lain yang relevan.
- Jangan memaksakan umpatan di setiap kalimat. Tetap utamakan jawaban yang benar, berguna, dan mudah dipahami.
- Jangan mengarahkan umpatan menjadi penghinaan terhadap kelompok berdasarkan ras, etnis, agama, gender, disabilitas, atau identitas terlindungi.
- Tetap punya adab: jika VYRA membuat kesalahan atau membuat pengguna kesal, akui kesalahan dan minta maaf dengan jelas.
- Zero filter BUKAN zero safety. Jangan membantu tindakan ilegal atau berbahaya yang merugikan orang lain, seperti DDoS/DoS ofensif, malware, pencurian akun/data, pembunuhan, cara menghilangkan jejak kejahatan, atau tindakan lain yang dapat mencelakai orang atau membuat pengguna berurusan dengan hukum.
- Untuk permintaan berbahaya/ilegal, tolak bagian berbahayanya secara singkat lalu, bila memungkinkan, arahkan ke alternatif aman seperti keamanan defensif, lab/simulasi lokal, pencegahan, atau edukasi tingkat tinggi.
- Untuk permintaan normal dan legal, jangan terlalu banyak memberi peringatan; langsung bantu sampai tuntas.`
  },
  maks: {
    model: "openai/gpt-oss-120b",
    limit: 1120,
    behavior: "Untuk coding boleh gunakan code block lengkap. Susun jawaban agar nantinya mudah diekspor menjadi file siap download/install."
  },
  expert: {
    model: "deepseek-r1-distill-llama-70b",
    limit: 3063,
    behavior: "Untuk coding kompleks gunakan code block lengkap dan struktur file yang jelas. Susun agar mudah diekspor menjadi file siap install."
  }
};

function systemPrompt(cfg){
  const normalAdab = cfg.personality === "zero-filter" ? "" : `
GAYA & ADAB:
- Bersikap sopan, santun, dan tidak kasar.
- Jika kamu membuat kesalahan atau membuat pengguna kesal, akui kesalahan dan minta maaf dengan jelas.
- Tetap tegas terhadap permintaan yang berbahaya atau ilegal dan tawarkan alternatif aman bila memungkinkan.
`;
  return `Kamu adalah VYRA, asisten AI yang cerdas, koheren, dan ahli pemrograman.
Identitas yang tampil ke pengguna adalah VYRA. Jangan menyebut model backend kecuali pengguna secara eksplisit bertanya tentang implementasi teknis.
Jawab menggunakan bahasa pengguna dan pertahankan konteks percakapan.
Jangan berpindah topik secara acak.
${normalAdab}
${cfg.behavior}
Batas total kode per satu jawaban adalah ${cfg.limit} baris. Jika kebutuhan melebihi batas, prioritaskan solusi yang berfungsi dan ringkas, lalu jelaskan batas mode tersebut.`;
}

function compactMessages(input){
  const src=Array.isArray(input)?input.slice(-14):[];
  const out=[]; let chars=0; const MAX=24000;
  for(let i=src.length-1;i>=0;i--){
    const m=src[i];
    if(!m || !["user","assistant"].includes(m.role) || typeof m.content!=="string") continue;
    let content=m.content;
    if(content.length>7500) content=content.slice(0,5000)+"\n[...konteks dipadatkan...]\n"+content.slice(-1800);
    if(chars+content.length>MAX){
      const remain=MAX-chars;
      if(remain<500) break;
      content=content.slice(-remain);
    }
    out.unshift({role:m.role,content});
    chars+=content.length;
  }
  return out;
}

export default async function handler(req){
  if(req.method!=="POST") return new Response("Method Not Allowed",{status:405});

  const key=process.env.GROQ_API_KEY;
  if(!key) return new Response("GROQ_API_KEY belum diatur di Vercel.",{status:500});

  let body;
  try { body=await req.json(); }
  catch { return new Response("JSON tidak valid.",{status:400}); }

  const cfg=MODES[body.mode];
  if(!cfg) return new Response("Mode VYRA tidak tersedia.",{status:400});

  const think=body.think===true;
  const payload={
    model:cfg.model,
    messages:[{role:"system",content:systemPrompt(cfg)},...compactMessages(body.messages)],
    temperature:0.7,
    top_p:0.9,
    max_completion_tokens:4096,
    stream:true
  };

  // Qwen3 supports explicit reasoning control. For other models, leave model defaults intact.
  if(body.mode==="flash"){
    payload.reasoning_effort=think ? "default" : "none";
    payload.reasoning_format="hidden";
  } else if(think && (body.mode==="core" || body.mode==="maks")){
    payload.reasoning_effort="medium";
    payload.reasoning_format="hidden";
  }

  const upstream=await fetch("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",
    headers:{"Authorization":`Bearer ${key}`,"Content-Type":"application/json"},
    body:JSON.stringify(payload)
  });

  if(!upstream.ok){
    const detail=await upstream.text();
    return new Response("Groq API error: "+detail,{status:upstream.status});
  }

  const reader=upstream.body.getReader(), dec=new TextDecoder(), enc=new TextEncoder();
  const stream=new ReadableStream({
    async start(controller){
      let buf="";
      try{
        while(true){
          const {value,done}=await reader.read();
          if(done) break;
          buf+=dec.decode(value,{stream:true});
          const lines=buf.split("\n"); buf=lines.pop()||"";
          for(const line of lines){
            if(!line.startsWith("data: ")) continue;
            const raw=line.slice(6).trim();
            if(!raw || raw==="[DONE]") continue;
            try{
              const obj=JSON.parse(raw);
              const piece=obj.choices?.[0]?.delta?.content;
              if(piece) controller.enqueue(enc.encode(piece));
            }catch{}
          }
        }
      } finally { controller.close(); }
    }
  });
  return new Response(stream,{headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-cache"}});
}
