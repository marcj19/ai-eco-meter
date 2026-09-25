# AI Eco Meter: a pegada da sua IA

Uma extensão para VS Code que mostra, de um jeito **divertido e consciente**, quanta **energia, água e CO₂** o seu uso de inteligência artificial consome, junto com **tokens, requisições e médias**.

Um planetinha mascote reage ao seu consumo do dia: fica **radiante** quando o uso está leve e **com calor** quando a meta diária estoura.

## O que tem

- **Bichinhos em pixel art** passeando no rodapé: gato, capivara (com laranjinha na cabeça), pato, cachorro, tartaruga e caranguejo. Eles andam, sentam e cochilam. Clique num deles para ele pular e comentar seu consumo do dia. Em dia quente, suam e andam mais devagar. No painel completo eles ficam maiores.
- **Aba e seção "Bichinhos"**: os bichinhos também moram numa aba no painel de baixo (junto do Terminal) e numa seção no fim do Explorer. Deixe a aba bem fininha e eles ficam passeando no cantinho enquanto você trabalha. Para esconder, clique com o botão direito no título e escolha *Ocultar*.
- **Bichinhos dentro do editor** (experimental, desligado): `aiEcoMeter.pets.inEditor` coloca versões pequenas depois do código da última linha visível. Como a API do VS Code não permite fixá-los na borda da janela, eles acompanham a rolagem.
- **Quintal do planeta** (jogo idle na aba Bichinhos): os bichinhos cultivam canteiros e **colhem sementes sozinhos**. O grande objetivo é **restaurar os biomas brasileiros** (Cerrado, Caatinga, Pantanal, Mata Atlântica e Amazônia) plantando árvores: cada um muda o cenário, traz um bicho típico e dá bônus permanente, e depois vem uma nova volta. Há **missões do dia** (uma delas sempre ligada ao uso consciente de IA) e uma loja sem limite de níveis. O ritmo acompanha o seu uso de IA: dia leve rende até +50%, dia pesado deixa todo mundo com calor (−30%), sem nunca perder progresso. O progresso continua (pela metade) com o VS Code fechado, por até 8 h.
- **Planeta mascote animado**: pisca, flutua e muda de humor (radiante → tranquila → preocupada → com calor). As turbinas eólicas giram mais rápido quando o consumo está baixo. Clique no planeta para ouvir outra frase.
- **Bateria e copo d'água animados**: se enchem conforme a energia e a água gastas, em relação à sua meta.
- **Métricas**: tokens (entrada/saída/cache), requisições, média de tokens por requisição e por dia, CO₂ e horário de pico.
- **"Isso equivale a…"**: cargas de celular, horas de lâmpada LED, streaming, micro-ondas, copos d'água, segundos de chuveiro, km de carro, dias de uma árvore absorvendo CO₂. Cada item tem sua ilustração animada.
- **Para onde vai a energia**: mostra que ler do cache é barato e que gerar texto é caro.
- **Histórico** por hora (hoje) ou por dia (7 / 30 / todos os dias), com linha de meta e tooltips.
- **Por modelo**: quais modelos consomem mais.
- **Dicas conscientes** que se adaptam ao seu uso real.
- **Conquistas** com medalhas em pixel art: Primeira gota, Mestre do cache, Dia zen, Semana verde, Coruja…
- **Barra de status** com o consumo de hoje (clique para abrir o painel).

## De onde vêm os dados

| Fonte | Como | Precisão |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | Tokens reais de cada requisição |
| **OpenAI Codex CLI** | `~/.codex/sessions/**/*.jsonl` | Tokens reais |
| **Gemini CLI** | `~/.gemini/tmp/*/chats/*.jsonl` | Tokens reais (inclui raciocínio) |
| **Antigravity** | `~/.gemini/antigravity/conversations` | **Estimativa**: as conversas são criptografadas, então usamos o tamanho de cada uma (~4 bytes por token, ~20% de texto gerado) |
| **ChatGPT, Gemini, Copilot, Claude.ai…** | Registro manual rápido: botão **＋** no painel ou comando *AI Eco Meter: Registrar uso manual* | ChatGPT e Gemini usam os valores **oficiais** por pergunta (OpenAI: 0,34 Wh e 0,32 mL; Google: 0,24 Wh e 0,26 mL) |

Nada sai do seu computador. A leitura é incremental: só as linhas novas são processadas a cada atualização.

## Como calculamos

Energia (Wh) = tokens ÷ 1000 × coeficiente × fator do modelo

| Tipo de token | Padrão (Wh / 1.000 tokens) |
|---|---|
| Saída (gerados) | 1,0 |
| Entrada (sem cache) | 0,1 |
| Cache: escrita | 0,12 |
| Cache: leitura | 0,01 |

Fatores de modelo: haiku/mini/flash ×0,35 · sonnet ×1 · opus ×2 · fable ×3.
Água = energia × **1,8 L/kWh** · CO₂ = energia × **400 g/kWh**.

São **estimativas de ordem de grandeza**. Nenhum provedor publica o consumo exato por token. Referências usadas para calibrar:

- Google (2025): prompt mediano do Gemini ≈ 0,24 Wh e 0,26 mL de água
- Epoch AI (2025): consulta típica ao GPT-4o ≈ 0,3 Wh
- Mistral (2025, ciclo de vida do Mistral Large 2): resposta de 400 tokens ≈ 45 mL de água e 1,14 g CO₂e (inclui treino)

Todos os coeficientes são ajustáveis em **Configurações → AI Eco Meter**.

## Configurações

| Chave | Padrão | |
|---|---|---|
| `aiEcoMeter.dailyEnergyBudgetWh` | `1000` | Meta diária de energia (define o humor do mascote) |
| `aiEcoMeter.coefficients.*` | ver acima | Wh por 1.000 tokens |
| `aiEcoMeter.modelMultipliers` | ver acima | Fator por família de modelo |
| `aiEcoMeter.waterLitersPerKWh` | `1.8` | Água por kWh |
| `aiEcoMeter.gridCo2GramsPerKWh` | `400` | Intensidade de carbono da rede |
| `aiEcoMeter.sources.claudeCode` / `.codex` / `.geminiCli` / `.antigravity` | `true` | Ativar/desativar fontes |
| `aiEcoMeter.paths.claudeCode` / `.codex` / `.gemini` / `.antigravity` | vazio | Pastas alternativas dos logs |
| `aiEcoMeter.refreshIntervalSeconds` | `60` | Intervalo de atualização |
| `aiEcoMeter.showStatusBar` | `true` | Mostrar na barra de status |
| `aiEcoMeter.pets.enabled` | `true` | Mostrar os bichinhos |
| `aiEcoMeter.game.enabled` | `true` | Jogo "Quintal do planeta" na aba Bichinhos |
| `aiEcoMeter.pets.inEditor` | `false` | Experimental: bichinhos dentro do editor |
| `aiEcoMeter.pets.list` | `["gato","capivara","pato"]` | Quais bichinhos (até 6): `gato`, `cachorro`, `pato`, `capivara`, `tartaruga`, `caranguejo` |

## Instalar

```bash
code --install-extension ai-eco-meter-0.5.0.vsix
```

Ou, para desenvolver: abra esta pasta no VS Code e aperte **F5** (não precisa de `npm install`, é JavaScript puro, sem dependências).

Para gerar o `.vsix` (use sempre a ferramenta oficial para publicar nas lojas): `npx @vscode/vsce package --no-dependencies`.
