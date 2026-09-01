const YT_API = "https://www.googleapis.com/youtube/v3";

const els = {
  ytKey: document.getElementById("yt-key"),
  geminiKey: document.getElementById("gemini-key"),
  geminiModel: document.getElementById("gemini-model"),
  rememberKeys: document.getElementById("remember-keys"),
  myChannel: document.getElementById("my-channel"),
  competitors: document.getElementById("competitors"),
  monthsBack: document.getElementById("months-back"),
  analyzeBtn: document.getElementById("analyze-btn"),
  statusCard: document.getElementById("status-card"),
  statusLog: document.getElementById("status-log"),
  resultsCard: document.getElementById("results-card"),
  analysisSummary: document.getElementById("analysis-summary"),
  ideasGrid: document.getElementById("ideas-grid"),
  videosCard: document.getElementById("videos-card"),
  videosTable: document.getElementById("videos-table"),
};

// ---------- persistence ----------
function loadSaved() {
  els.ytKey.value = localStorage.getItem("yif_yt_key") || "";
  els.geminiKey.value = localStorage.getItem("yif_gemini_key") || "";
  localStorage.removeItem("yif_gemini_model"); // avoid ever getting stuck on a model Google has since retired
  els.myChannel.value = localStorage.getItem("yif_my_channel") || "";
  els.competitors.value = localStorage.getItem("yif_competitors") || "";
  els.rememberKeys.checked = localStorage.getItem("yif_remember") !== "0";
}

function saveState() {
  if (els.rememberKeys.checked) {
    localStorage.setItem("yif_yt_key", els.ytKey.value.trim());
    localStorage.setItem("yif_gemini_key", els.geminiKey.value.trim());
    localStorage.setItem("yif_remember", "1");
  } else {
    localStorage.removeItem("yif_yt_key");
    localStorage.removeItem("yif_gemini_key");
    localStorage.setItem("yif_remember", "0");
  }
  localStorage.setItem("yif_my_channel", els.myChannel.value.trim());
  localStorage.setItem("yif_competitors", els.competitors.value.trim());
}

loadSaved();

document.querySelector('[data-toggle="setup-body"]').addEventListener("click", () => {
  const body = document.getElementById("setup-body");
  const head = document.querySelector('[data-toggle="setup-body"]');
  body.hidden = !body.hidden;
  head.classList.toggle("collapsed", body.hidden);
});

// ---------- status log ----------
function resetLog() {
  els.statusCard.hidden = false;
  els.statusLog.innerHTML = "";
}
function log(msg, kind) {
  const li = document.createElement("li");
  li.textContent = msg;
  if (kind) li.className = kind;
  els.statusLog.appendChild(li);
  li.scrollIntoView({ block: "nearest" });
}

// ---------- channel input parsing ----------
function parseChannelInput(raw) {
  const input = raw.trim();
  let m;
  if ((m = input.match(/youtube\.com\/channel\/(UC[\w-]{10,})/i))) return { type: "id", value: m[1] };
  if (/^UC[\w-]{10,}$/.test(input)) return { type: "id", value: input };
  if ((m = input.match(/youtube\.com\/@([\w.\-]+)/i))) return { type: "handle", value: "@" + m[1] };
  if (input.startsWith("@")) return { type: "handle", value: input };
  if ((m = input.match(/youtube\.com\/user\/([\w\-]+)/i))) return { type: "username", value: m[1] };
  if ((m = input.match(/youtube\.com\/c\/([\w\-]+)/i))) return { type: "custom", value: m[1] };
  return { type: "custom", value: input.replace(/^https?:\/\/(www\.)?youtube\.com\//i, "") };
}

async function ytFetch(path, params) {
  const url = new URL(`${YT_API}/${path}`);
  url.searchParams.set("key", els.ytKey.value.trim());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const reason = data?.error?.message || res.statusText;
    throw new Error(`YouTube API error: ${reason}`);
  }
  return data;
}

async function resolveChannel(raw) {
  const parsed = parseChannelInput(raw);
  const baseParts = "snippet,statistics,contentDetails";

  if (parsed.type === "id") {
    const data = await ytFetch("channels", { part: baseParts, id: parsed.value });
    if (data.items?.length) return data.items[0];
  } else if (parsed.type === "handle") {
    const data = await ytFetch("channels", { part: baseParts, forHandle: parsed.value });
    if (data.items?.length) return data.items[0];
  } else if (parsed.type === "username") {
    const data = await ytFetch("channels", { part: baseParts, forUsername: parsed.value });
    if (data.items?.length) return data.items[0];
  }

  // fallback: try as a handle guess, then full search
  if (parsed.type === "custom") {
    try {
      const asHandle = await ytFetch("channels", { part: baseParts, forHandle: "@" + parsed.value });
      if (asHandle.items?.length) return asHandle.items[0];
    } catch (_) {}
  }

  const search = await ytFetch("search", { part: "snippet", type: "channel", q: parsed.value, maxResults: 1 });
  if (search.items?.length) {
    const channelId = search.items[0].snippet.channelId;
    const data = await ytFetch("channels", { part: baseParts, id: channelId });
    if (data.items?.length) return data.items[0];
  }

  throw new Error(`مقدرتش ألاقي القناة: ${raw}`);
}

async function fetchRecentVideos(channel, cutoffDate) {
  const uploadsPlaylist = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylist) return [];

  const videoIds = [];
  let pageToken;
  let pages = 0;

  outer: while (pages < 12) {
    pages++;
    const data = await ytFetch("playlistItems", {
      part: "contentDetails",
      playlistId: uploadsPlaylist,
      maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });

    for (const item of data.items || []) {
      const publishedAt = new Date(item.contentDetails.videoPublishedAt);
      if (publishedAt < cutoffDate) break outer;
      videoIds.push(item.contentDetails.videoId);
    }

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  const videos = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const data = await ytFetch("videos", { part: "snippet,statistics,contentDetails", id: chunk.join(",") });
    for (const v of data.items || []) {
      const duration = v.contentDetails?.duration || "";
      const isShort = /PT[0-9]+S$/.test(duration) || /PT[1-5]?[0-9]S$/.test(duration);
      videos.push({
        id: v.id,
        title: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
        views: parseInt(v.statistics.viewCount || "0", 10),
        likes: parseInt(v.statistics.likeCount || "0", 10),
        comments: parseInt(v.statistics.commentCount || "0", 10),
        channelTitle: channel.snippet.title,
        channelId: channel.id,
        isShort,
      });
    }
  }
  return videos;
}

function scoreVideos(allVideos) {
  const byChannel = {};
  for (const v of allVideos) (byChannel[v.channelId] ||= []).push(v);

  for (const channelVideos of Object.values(byChannel)) {
    const sortedViews = channelVideos.map((v) => v.views).sort((a, b) => a - b);
    const median = sortedViews[Math.floor(sortedViews.length / 2)] || 1;
    for (const v of channelVideos) {
      v.outlierScore = v.views / Math.max(median, 1);
    }
  }
  return allVideos.sort((a, b) => b.outlierScore - a.outlierScore);
}

// ---------- rendering ----------
function renderVideosTable(videos) {
  els.videosCard.hidden = false;
  els.videosTable.innerHTML = "";
  const top = videos.slice(0, 20);
  for (const v of top) {
    const row = document.createElement("div");
    row.className = "videos-table-row";
    const daysAgo = Math.max(1, Math.round((Date.now() - new Date(v.publishedAt)) / 86400000));
    row.innerHTML = `
      <img src="${v.thumbnail || ""}" alt="">
      <div>
        <span class="vt-title"><a href="https://www.youtube.com/watch?v=${v.id}" target="_blank" rel="noopener">${escapeHtml(v.title)}</a></span>
        <span class="vt-meta">${escapeHtml(v.channelTitle)} · ${v.views.toLocaleString("ar-EG")} مشاهدة · من ${daysAgo} يوم${v.isShort ? " · Shorts" : ""}</span>
      </div>
      <div class="vt-score">×${v.outlierScore.toFixed(1)}</div>
    `;
    els.videosTable.appendChild(row);
  }
}

function scoreBadgeClass(score) {
  if (score >= 70) return "good";
  if (score >= 40) return "mid";
  return "low";
}

function renderIdeas(result) {
  els.resultsCard.hidden = false;
  els.analysisSummary.textContent = result.analysis_summary || "";
  els.ideasGrid.innerHTML = "";
  for (const idea of result.ideas || []) {
    const card = document.createElement("div");
    card.className = "idea-card";
    card.innerHTML = `
      <div class="idea-card-head">
        <h3 class="idea-title">${escapeHtml(idea.title || "")}</h3>
        <div class="score-badge ${scoreBadgeClass(idea.success_score || 0)}">${idea.success_score ?? "?"}%</div>
      </div>
      <div class="idea-meta">
        ${idea.format ? `<span>${escapeHtml(idea.format)}</span>` : ""}
      </div>
      ${idea.hook ? `<p><span class="label">الهوك:</span> ${escapeHtml(idea.hook)}</p>` : ""}
      ${idea.why_it_works ? `<p><span class="label">ليه هتنجح:</span> ${escapeHtml(idea.why_it_works)}</p>` : ""}
      ${idea.thumbnail_idea ? `<p><span class="label">فكرة الثامبنيل:</span> ${escapeHtml(idea.thumbnail_idea)}</p>` : ""}
      ${idea.based_on_pattern ? `<p><span class="label">مبنية على:</span> ${escapeHtml(idea.based_on_pattern)}</p>` : ""}
    `;
    els.ideasGrid.appendChild(card);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- gemini ----------
async function askGemini({ myChannel, topVideos, competitorNames, monthsBack }) {
  const model = els.geminiModel.value.trim() || "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(els.geminiKey.value.trim())}`;

  const dataForPrompt = topVideos.slice(0, 25).map((v) => ({
    title: v.title,
    channel: v.channelTitle,
    views: v.views,
    outlier_score: Number(v.outlierScore.toFixed(2)),
    days_ago: Math.round((Date.now() - new Date(v.publishedAt)) / 86400000),
    is_short: v.isShort,
  }));

  const prompt = `انت خبير استراتيجية محتوى يوتيوب. تحت هتلاقي بيانات فعلية عن أكتر الفيديوهات اللي "ضربت" (outlier_score = نسبة مشاهدات الفيديو لمتوسط مشاهدات نفس القناة في آخر ${monthsBack} شهور، يعني رقم أعلى من 1 معناه الفيديو ضرب أكتر من المعتاد لنفس القناة).

قناة المستخدم: ${myChannel || "مش متاحة - اقترح أفكار عامة تناسب نفس مجال المنافسين"}
أسماء قنوات المنافسين اللي اتحللت: ${competitorNames.join("، ")}

بيانات الفيديوهات الرائجة (الأعلى outlier_score الأول):
${JSON.stringify(dataForPrompt, null, 2)}

المطلوب:
1. حلل الأنماط المشتركة بين الفيديوهات اللي ضربت (نوع العنوان، الموضوع، الزاوية، الفورمات shorts ولا long-form).
2. اقترح 5 أفكار فيديو جديدة ومحددة (مش عامة) مناسبة لقناة المستخدم، مبنية على الأنماط دي لكن مش نسخ حرفي لأي فيديو موجود.
3. لكل فكرة، قيّم احتمال نجاحها من 0 لـ100 بناءً على قوة الدليل من البيانات (مدى تكرار النمط ده وارتفاع outlier_score بتاعه).
4. اكتب كل حاجة باللغة العربية (بالعامية المصرية البسيطة).

رد بصيغة JSON بس حسب الـ schema المحدد.`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          analysis_summary: { type: "STRING" },
          ideas: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                title: { type: "STRING" },
                format: { type: "STRING" },
                hook: { type: "STRING" },
                why_it_works: { type: "STRING" },
                thumbnail_idea: { type: "STRING" },
                success_score: { type: "INTEGER" },
                based_on_pattern: { type: "STRING" },
              },
              required: ["title", "hook", "why_it_works", "thumbnail_idea", "success_score"],
            },
          },
        },
        required: ["analysis_summary", "ideas"],
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini API error: ${data?.error?.message || res.statusText}`);
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini مرجعش نتيجة قابلة للقراءة");
  return JSON.parse(text);
}

// ---------- main flow ----------
async function runAnalysis() {
  if (!els.ytKey.value.trim()) return alert("محتاج تحط مفتاح YouTube Data API الأول");
  if (!els.geminiKey.value.trim()) return alert("محتاج تحط مفتاح Gemini API الأول");

  const competitorLines = els.competitors.value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!competitorLines.length) return alert("حط لينك قناة منافس واحد على الأقل");
  if (competitorLines.length > 8) return alert("لسه بتحدد بحد أقصى 8 قنوات في المرة الواحدة عشان الكوتة");

  saveState();
  els.analyzeBtn.disabled = true;
  els.analyzeBtn.textContent = "جاري التحليل...";
  resetLog();
  els.resultsCard.hidden = true;
  els.videosCard.hidden = true;

  try {
    const monthsBack = parseInt(els.monthsBack.value, 10);
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsBack);

    let myChannelName = "";
    if (els.myChannel.value.trim()) {
      try {
        log("بجيب بيانات قناتك...");
        const mine = await resolveChannel(els.myChannel.value.trim());
        myChannelName = `${mine.snippet.title} (${(mine.statistics.subscriberCount || "?")} مشترك)`;
        log(`تمام: ${mine.snippet.title}`, "ok");
      } catch (e) {
        log(`تخطيت قناتك: ${e.message}`, "err");
      }
    }

    const allVideos = [];
    const competitorNames = [];
    for (const line of competitorLines) {
      try {
        log(`بحلل القناة: ${line}`);
        const channel = await resolveChannel(line);
        competitorNames.push(channel.snippet.title);
        const videos = await fetchRecentVideos(channel, cutoffDate);
        log(`${channel.snippet.title}: ${videos.length} فيديو في آخر ${monthsBack} شهور`, "ok");
        allVideos.push(...videos);
      } catch (e) {
        log(`فشل تحليل "${line}": ${e.message}`, "err");
      }
    }

    if (!allVideos.length) {
      log("مفيش فيديوهات كفاية اتحللت، جرب قنوات تانية أو زود المدة", "err");
      return;
    }

    log("بحسب أداء كل فيديو نسبة لمتوسط قناته...");
    const ranked = scoreVideos(allVideos);
    renderVideosTable(ranked);

    log("بستشير Gemini AI عشان يقترح أفكار...");
    const result = await askGemini({ myChannel: myChannelName, topVideos: ranked, competitorNames, monthsBack });
    renderIdeas(result);
    log("خلصنا! 🎉", "ok");
  } catch (e) {
    log(`خطأ: ${e.message}`, "err");
    if (/Gemini API error/i.test(e.message)) {
      log('لو الخطأ بيقول إن الموديل مش متاح، افتح "إعداد متقدم" وغيّر اسم الموديل (مثلاً جرب الاسم اللي اقترحته الرسالة نفسها)، وبعدين دوس الزرار تاني.', "err");
    }
  } finally {
    els.analyzeBtn.disabled = false;
    els.analyzeBtn.textContent = "حلّل الفيديوهات الرائجة واقترح أفكار 🚀";
  }
}

els.analyzeBtn.addEventListener("click", runAnalysis);
