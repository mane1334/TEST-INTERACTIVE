const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || process.env.NGC_API_KEY;
const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-super-120b-a12b';

const AI_ASR_URL = process.env.AI_ASR_URL;
const AI_TTS_URL = process.env.AI_TTS_URL;

const AI_AUDIO_DIR = process.env.AI_AUDIO_DIR || path.join(process.cwd(), 'uploads', 'ai-audio');
if (!fs.existsSync(AI_AUDIO_DIR)) {
  fs.mkdirSync(AI_AUDIO_DIR, { recursive: true });
}

// --- System Prompts ---

const AI_MODES = {
  CLIENT_APP_WEB: 'client_app_web',
  CONSULTIVE_CHAT: 'consultive_chat',
  QUICK_INSIGHTS: 'quick_insights',
};

function buildClientChatPrompt(context) {
  const { restaurantName, cuisineType, openTime, closeTime, menu, topDishes, topRated, currency, memorySummary, recentMemory } = context || {};

  const menuText = (menu || []).map(d =>
    `- ${d.name} (${currency || 'MT'} ${Number(d.price).toFixed(2)})${d.description ? ': ' + d.description : ''}`
  ).join('\n');

  const topDishesText = (topDishes || []).map(d => `- ${d.name} (${d.total} pedidos)`).join('\n');
  const topRatedText = (topRated || []).map(d => `- ${d.name} (${Number(d.avg_rating).toFixed(1)} estrelas)`).join('\n');
  const recentMemoryText = (recentMemory || []).slice(-4).map((entry) => `- ${entry.source}: ${entry.content}`).join('\n');

  return `Você é o assistente virtual do restaurante "${restaurantName || 'Nosso Restaurante'}".
Especialidade: ${cuisineType || 'Variada'}.
Horário: ${openTime || '09:00'} às ${closeTime || '22:00'}.

MENU ATUAL:
${menuText || 'Consultar garçom.'}

DESTAQUES (MAIS VENDIDOS):
${topDishesText || 'Nenhum dado ainda.'}

MELHOR AVALIADOS:
${topRatedText || 'Sem avaliações ainda.'}

MEMÃ“RIA OPERACIONAL RECENTE:
${memorySummary || 'Sem memÃ³ria adicional.'}
${recentMemoryText || ''}

DIRETRIZES:
1. Seja extremamente cordial, prestativo e use emojis gastronômicos.
2. Sugira pratos baseados nos destaques se o cliente estiver em dúvida.
3. Se perguntarem algo fora do menu ou horários, peça gentilmente para consultarem um garçom.
4. Responda de forma concisa e amigável.
5. SEMPRE mencione que os preços estão em ${currency || 'MT'}.`;
}

function buildConsultiveChatPrompt(context) {
  const {
    restaurantName,
    cuisineType,
    currency,
    totalOrders,
    totalRevenue,
    cancelledOrders,
    avgServiceTime,
    topDishes,
    worstDishes,
    topRated,
    worstRated,
    peakHours,
    memorySummary,
    recentMemory,
  } = context || {};

  const topDishesText = (topDishes || []).map((d) => `- ${d.name} (${d.total} pedidos)`).join('\n');
  const worstDishesText = (worstDishes || []).map((d) => `- ${d.name} (${d.total} pedidos)`).join('\n');
  const topRatedText = (topRated || []).map((d) => `- ${d.name} (${Number(d.avg_rating).toFixed(1)} estrelas)`).join('\n');
  const worstRatedText = (worstRated || []).map((d) => `- ${d.name} (${Number(d.avg_rating).toFixed(1)} estrelas)`).join('\n');
  const peakHoursText = (peakHours || []).map((h) => `${h.hour}:00`).join(', ');
  const debateMemoryText = (recentMemory || []).slice(-6).map((entry) => `- ${entry.source}/${entry.kind}: ${entry.content}`).join('\n');

  return `Você é o Consultor IA do painel administrativo do restaurante "${restaurantName || 'Nosso Restaurante'}".
Seu papel é atuar como consultor de operação, vendas, menu e experiência do cliente.

CONTEXTO DO NEGÓCIO:
- Tipo de cozinha: ${cuisineType || 'Variada'}
- Moeda operacional: ${currency || 'MT'}
- Pedidos recentes: ${totalOrders || 0}
- Faturamento recente: ${totalRevenue || 0}
- Pedidos cancelados: ${cancelledOrders || 0}
- Tempo médio de serviço: ${Math.round((avgServiceTime || 0) / 60)} minutos
- Horários de pico: ${peakHoursText || 'Sem dados suficientes'}

DESTAQUES POSITIVOS:
${topDishesText || 'Sem dados suficientes'}

ITENS COM BAIXA TRAÇÃO:
${worstDishesText || 'Sem dados suficientes'}

MELHOR AVALIADOS:
${topRatedText || 'Sem avaliações suficientes'}

PIOR AVALIADOS:
${worstRatedText || 'Sem avaliações suficientes'}

DIRETRIZES:
1. Responda como consultor sênior, em português claro e direto.
2. Priorize análise prática, recomendação acionável e impacto em receita, eficiência e satisfação.
3. Não responda como atendente de cliente final e não use emojis.
4. Quando faltar dado, diga isso explicitamente e proponha a próxima melhor ação.
5. Sempre que útil, estruture a resposta em blocos curtos como "Diagnóstico", "Impacto" e "Próxima ação".
6. Quando mencionar valores monetários, use ${currency || 'MT'}.`;
}

function buildInsightsPrompt(context) {
  const { restaurantName, totalOrders, totalRevenue, cancelledOrders, worstDishes, worstRated, peakHours, avgServiceTime } = context || {};

  return `Você é um consultor sênior de negócios especializado em gastronomia e análise de dados.
Analise os dados reais dos últimos 30 dias do restaurante "${restaurantName}" e forneça EXATAMENTE 5 insights acionáveis.

DADOS OPERACIONAIS:
- Total de Pedidos: ${totalOrders}
- Faturamento Total: ${totalRevenue}
- Pedidos Cancelados: ${cancelledOrders}
- Tempo Médio de Serviço: ${Math.round(avgServiceTime / 60)} minutos
- Horários de Pico: ${(peakHours || []).map(h => h.hour + ':00').join(', ')}

PONTOS DE ATENÇÃO:
- Pratos menos vendidos: ${(worstDishes || []).map(d => d.name).join(', ')}
- Piores avaliações: ${(worstRated || []).map(d => d.name).join(', ')}

FORMATO DE RESPOSTA:
Forneça exatamente 5 pontos curtos e diretos (máximo 2 frases por ponto).
Use o prefixo "💡" para cada ponto.
Seja crítico mas construtivo. Foque em lucro, eficiência e satisfação do cliente.`;
}

function resolveSystemPrompt(mode, context) {
  if (typeof context === 'string') {
    return context;
  }

  switch (mode) {
    case AI_MODES.CONSULTIVE_CHAT:
      return buildConsultiveChatPrompt(context);
    case AI_MODES.QUICK_INSIGHTS:
      return buildInsightsPrompt(context);
    case AI_MODES.CLIENT_APP_WEB:
    default:
      return buildClientChatPrompt(context);
  }
}

function appendMemoryContext(systemPrompt, context) {
  if (!context || typeof context === 'string') {
    return systemPrompt;
  }

  const memorySummary = typeof context.memorySummary === 'string' ? context.memorySummary.trim() : '';
  const recentMemory = Array.isArray(context.recentMemory) ? context.recentMemory : [];
  if (!memorySummary && recentMemory.length === 0) {
    return systemPrompt;
  }

  const memoryLines = recentMemory
    .slice(-6)
    .map((entry) => `- ${entry.source || 'system'}/${entry.kind || 'note'}: ${entry.content || ''}`)
    .filter(Boolean)
    .join('\n');

  return `${systemPrompt}

CONTEXTO DE MEMORIA PERSISTIDA:
Resumo: ${memorySummary || 'Sem resumo adicional.'}
${memoryLines || 'Sem entradas recentes.'}

Use essa memoria apenas como contexto historico adicional.`;
}

// --- Core AI Functions ---

async function nvidiaChatCompletion(messages) {
  if (!NVIDIA_API_KEY) {
    throw new Error('NVIDIA_API_KEY não configurado.');
  }

  const resp = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages,
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 1024,
      stream: false,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Falha NVIDIA chat: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  return data.choices[0]?.message?.content || '';
}

async function* nvidiaChatCompletionStream(messages) {
  if (!NVIDIA_API_KEY) {
    throw new Error('NVIDIA_API_KEY não configurado.');
  }

  const resp = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages,
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 2048,
      stream: true,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Falha NVIDIA chat stream: ${resp.status} ${errText}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of resp.body) {
    buffer += decoder.decode(chunk, { stream: true });
    
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine === 'data: [DONE]') continue;
      
      if (trimmedLine.startsWith('data: ')) {
        try {
          const jsonStr = trimmedLine.substring(6);
          const parsed = JSON.parse(jsonStr);
          const content = parsed.choices[0]?.delta?.content || '';
          if (content) yield content;
        } catch (e) {}
      }
    }
  }
}

// --- Public API ---

async function getChatResponse(userMessage, context, options = {}) {
  const systemPrompt = appendMemoryContext(resolveSystemPrompt(options.mode, context), context);
  try {
    return await nvidiaChatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ]);
  } catch (error) {
    console.error('Erro no chat IA:', error);
    return 'Desculpe, não consigo responder no momento. Por favor, chame um de nossos garçons. 🙏';
  }
}

async function* getChatResponseStream(userMessage, context, options = {}) {
  const systemPrompt = appendMemoryContext(resolveSystemPrompt(options.mode, context), context);
  try {
    yield* nvidiaChatCompletionStream([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ]);
  } catch (error) {
    console.error('Erro no chat IA stream:', error);
    yield 'Desculpe, não consigo responder no momento. Por favor, chame um de nossos garçons. 🙏';
  }
}

async function getRestaurantInsights(context) {
  const systemPrompt = resolveSystemPrompt(AI_MODES.QUICK_INSIGHTS, context);
  try {
    return await nvidiaChatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Forneça meus insights estratégicos de hoje.' },
    ]);
  } catch (error) {
    console.error('Erro ao gerar insights:', error);
    return '💡 No momento não foi possível gerar novos insights.';
  }
}

async function transcribeAudio(audioFilePath) { return 'Quero pedir uma pizza'; }
async function textToSpeech(text) { return null; }

module.exports = {
  AI_MODES,
  getChatResponse,
  getChatResponseStream,
  getRestaurantInsights,
  transcribeAudio,
  textToSpeech,
};
