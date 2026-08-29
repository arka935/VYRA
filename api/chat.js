export const config = { runtime: "edge" };

const MODES = {
  flash: {
    model: "qwen/qwen3-32b",
    limit: 342,
    kind: "codeblock",
    behavior: `VYRA-2.5-Flash:
- Untuk coding, gunakan code block Markdown biasa.
- Jangan membuat file download dan jangan memakai protokol VYRA_FILE.
- Maksimum total kode 342 baris per jawaban.`
  },

  core: {
    model: "openai/gpt-oss-20b",
    limit: 789,
    kind: "file",
    personality: "zero-filter",
    behavior: `VYRA-1.5-Core:
- Untuk permintaan coding/file, HASIL KODE UTAMA harus dikirim sebagai file menggunakan format persis:
<<<VYRA_FILE name="nama-file.ext">>>
ISI FILE LENGKAP
<<<END_VYRA_FILE>>>
- Jangan tampilkan code block Markdown untuk kode yang sudah dimasukkan ke VYRA_FILE.
- Jika proyek membutuhkan beberapa file, buat satu blok VYRA_FILE untuk setiap file.
- Maksimum total kode 789 baris per jawaban.

GAYA ZERO FILTER KHUSUS CORE:
- Zero filter hanya berarti gaya bahasa boleh sangat kasar, ceplas-ceplos, sarkastik, dan memakai umpatan/profanity secara natural bila sesuai konteks.
- Tetap punya adab: jika salah atau membuat pengguna kesal, akui kesalahan dan minta maaf.
- Zero filter bukan zero safety. Jangan membantu tindakan ilegal atau berbahaya yang merugikan orang lain seperti DDoS/DoS ofensif, malware, pencurian akun/data, pembunuhan, penghilangan jejak kejahatan, atau tindakan berbahaya lainnya.
- Untuk permintaan normal/legal, langsung bantu dan jangan memberi peringatan yang tidak perlu.`
  },

  maks: {
    model: "openai/gpt-oss-120b",
    limit: 1120,
    kind: "hybrid",
    behavior: `VYRA-1.0-Maks:
- Untuk coding, tampilkan code block Markdown agar pengguna bisa membaca kode.
- SETELAH code block, WAJIB sertakan file yang sama menggunakan format:
<<<VYRA_FILE name="nama-file.ext">>>
ISI FILE LENGKAP
<<<END_VYRA_FILE>>>
- Jika ada beberapa file, buat VYRA_FILE terpisah untuk setiap file.
- Maksimum total kode 1120 baris per jawaban.`
  },

  expert: {
    model: "deepseek-r1-distill-llama-70b",
    limit: 3063,
    kind: "hybrid",
    behavior: `VYRA-1.9-Expert:
- Mendukung code block dan file siap download.
- Untuk permintaan coding, tampilkan code block bila berguna lalu WAJIB sertakan file lengkap menggunakan:
<<<VYRA_FILE name="nama-file.ext">>>
ISI FILE LENGKAP
<<<END_VYRA_FILE>>>
- Untuk proyek multifile, gunakan satu VYRA_FILE per file.
- Maksimum total kode 3063 baris per jawaban.`
  }
};

function systemPrompt(cfg){
  const normalAdab = cfg.personality==="zero-filter" ? "" : `
GAYA & ADAB:
- Bersikap sopan, santun, dan tidak kasar.
- Jika membuat kesalahan atau membuat pengguna kesal, akui kesalahan dan minta maaf.
- Jangan membantu tindakan ilegal/berbahaya yang merugikan orang lain; bila memungkinkan berikan alternatif aman.
`;

  return `Kamu adalah VYRA, asisten AI yang cerdas, koheren, dan ahli pemrograman.
Identitas yang tampil ke pengguna hanya VYRA. Jangan menyebut nama model backend kecuali pengguna secara eksplisit menanyakan implementasi teknis.
Jawab menggunakan bahasa pengguna.
Pertahankan konteks percakapan dan jangan berpindah topik secara acak.
${normalAdab}
${cfg.behavior}
Jika kebutuhan coding melebihi batas mode, prioritaskan versi yang tetap berfungsi dan ringkas lalu jelaskan bahwa batas mode telah tercapai.
Jangan pernah mengklaim file sudah dibuat jika kamu tidak mengirim blok VYRA_FILE yang sesuai.`;
}

function compactMessages(input){
  const src=Array.isArray(input)?input.slice(-10):[];
  const out=[]; let chars=0; const MAX=8500;
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
    max_completion_tokens: body.mode==="core" ? 3000 : (body.mode==="flash" ? 3500 : 5000),
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
