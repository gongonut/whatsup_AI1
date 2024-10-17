import { join } from 'path'
import 'dotenv/config'
import { OpenAI } from 'openai';
import { createBot, createProvider, createFlow, addKeyword, utils, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'

interface UserQueue {
    from: string;
    thread: string;
    runId?: string;
    ctx: any;
    actualMenu: string;
    status: string;
    idleStep: number;
    messagetimestamp: number;
    messages: { role: string, content: string, time: number }[]
}

const PORT = process.env.PORT ?? 3008
const { ASSISTANT_ID, OPENAI_API_KEY, IDLE_MINUTES} = process.env;
const userQueues: UserQueue[] = [];
let pollingInterval;
// setup OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const defaultFlow = addKeyword<Provider, Database>(EVENTS.WELCOME)
    .addAction(
        async (ctx, ctxFn) => {
            if (process.env.NODE_STATUS === 'stopped') {
                ctxFn.flowDynamic('Servidor apagado');
                return;
            }
            
            const user = userQueues.find(u => u.from === ctx.from);
            if (!user) {
                // userQueues.set(ctx.from, { ...ctx, ...{ menuStatus: 0 } });
                const thread = await createThread();
                userQueues.push({
                    from: ctx.from,
                    thread: thread.id,
                    ctx,
                    actualMenu: 'NONE',
                    status: 'pending',
                    idleStep: 0,
                    messagetimestamp: Date.now(),
                    messages: [{ role: "user", content: ctx.body, time: Date.now() }],
                });
                ctxFn.gotoFlow(welcomeFlow);
            } else {
                if (ctx.body === '0') { ctxFn.gotoFlow(menuFlow); }
                switch (user.actualMenu) {
                    case '1':
                        if (user.status === 'pending') {
                            user.status = 'starting';
                            ctxFn.flowDynamic('Un momento por favor, estamos procesando su consulta...');
                            sendProductMessage(user.thread, ctx.body).then(answer => {
                                runAssistant(user.thread).then(run => {
                                    user.runId = run.id;

                                    // Check the status
                                    pollingInterval = setInterval(() => {
                                        checkingStatus(ctxFn, user, user.runId);
                                    }, 2000);
                                });
                            });
                        } else {
                            // openai.beta.threads.runs.cancel(user.thread, user.runId);
                            // ctxFn.flowDynamic('Cancelando consulta anterior... Por favor escriba su nueva consulta');
                            ctxFn.gotoFlow(pendingFlow);
                        }

                        break;
                    case '2':
                        ctxFn.flowDynamic('AUN NO TENEMOS DATOS DE SOPORTE');
                        break;
                }
            }

        }
    )

const pendingFlow = addKeyword<Provider, Database>(EVENTS.ACTION)
    .addAnswer('Procesando consulta anterior, espere por favor...')

const welcomeFlow = addKeyword<Provider, Database>(EVENTS.ACTION)
    .addAnswer(`Hola, bienvenido a *Cyber Cloud*`, { media: 'https://static.wixstatic.com/media/82643f_e3ce633fe3dd4190bc3f59047d7517a9~mv2.jpg/v1/fill/w_193,h_79,al_c,q_80,usm_0.66_1.00_0.01,enc_auto/SYT%20logo-02.jpg' })
    .addAnswer('Este es nuestro chat general. Elige una opción del *Menú* para ayudarte a resolver tus dudas', { delay: 800 })
    .addAction(
        async (_, ctxFn) => { ctxFn.gotoFlow(menuFlow); }
    )

const menuFlow = addKeyword<Provider, Database>(EVENTS.ACTION)
    .addAnswer(`*Menú*
                    1. Nuestros productos IA.
                    2. Soporte IA.
                    3. Contactar con un asesor.
                    0. Regresar al *Menú*.
                    E. Finalizar conversación.`, { capture: true },
        async (ctx, ctxFn) => {
            if (!['1', '2', '3', 'E'].includes(ctx.body[0])) { ctxFn.gotoFlow(menuFlow); }
            const from = userQueues.find(u => u.from === ctx.from);
            if (from) {
                from.actualMenu = ctx.body;
                from.messages.push({ role: "user", content: ctx.body, time: Date.now() });
            }
            // userQueues.set(ctx.from, [...[{ menu: ctx.body, messageTimestamp: ctx.messageTimestamp }], ...userQueues.get(ctx.from)]);
            // console.log(userQueues)
            switch (ctx.body) {
                case '1':
                    await ctxFn.flowDynamic('Ha seleccionado: *Asesor de productos IA*. Escriba su pregunta o consulta.');
                    await ctxFn.flowDynamic('Para regresar al *Menú* escriba *0*.');
                    break;
                case '2':
                    // ctxFn.gotoFlow(SupportFlow);
                    await ctxFn.flowDynamic('Ha seleccionado: *Soporte IA*. Escriba su pregunta o consulta.');
                    await ctxFn.flowDynamic('Escriba su pregunta o consulta.');
                    await ctxFn.flowDynamic('Para regresar al *Menú* escribe *0*.');
                    break;
                case '3':
                    //ctxFn.gotoFlow(ContactFlow);
                    await ctxFn.flowDynamic('Ha seleccionado: *Contactar con un asesor*')
                    await ctxFn.flowDynamic('Espere un momento por favor, pronto un asesor le atenderá.')
                    await ctxFn.flowDynamic('Para regresar al *Menú* escribe *0*');
                    break;
            }
        });

/*
const SupportFlow = addKeyword<Provider, Database>(EVENTS.ACTION)
.addAnswer('*Soporte IA*')
.addAnswer('Escriba su pregunta o consulta.')
.addAnswer('Para regresar al *Menú* escribe *0*');

const ContactFlow = addKeyword<Provider, Database>(EVENTS.ACTION)
.addAnswer('*Contactar con un asesor*')
.addAnswer('Espere un momento por favor, pronto un asesor le atendera.')
.addAnswer('Para regresar al *Menú* escribe *0*');

const ProductsFlow = addKeyword<Provider, Database>(EVENTS.ACTION)
.addAnswer('*Asesor de productos IA*')
.addAnswer('Para regresar al *Menú* escribe *0*');
*/

async function createThread() {
    const thread = await openai.beta.threads.create({});
    return thread;
}

async function sendProductMessage(threadId, message) {
    const response = await openai.beta.threads.messages.create(threadId, {
        role: "user", content: message
    });
    return response;
}

async function runAssistant(threadId) {
    // console.log('Running assistant for thread: ' + threadId)
    const response = await openai.beta.threads.runs.create(
        threadId,
        {
            assistant_id: ASSISTANT_ID
            // Make sure to not overwrite the original instruction, unless you want to
        }
    );

    // console.log(response)

    return response;
}


async function checkingStatus(ctxFn, user, runId) {
    const runObject = await openai.beta.threads.runs.retrieve(
        user.thread,
        runId
    );

    // const status = runObject.status;
    user.status = runObject.status;
    // console.log(runObject)
    console.log('Current status: ' + user.status);

    if (user.status == 'completed') {
        clearInterval(pollingInterval);

        const messagesList = await openai.beta.threads.messages.list(user.thread);
        const messages = []

        messagesList.data.forEach(message => {
            messages.push(message.content);
        });

        const message = messagesList.data[0].content[0] as any;
        // console.log('Message: ' + message);
        // console.log(message.text.value);
        ctxFn.flowDynamic(message.text.value);
        await ctxFn.flowDynamic('Para regresar al *Menú* escriba *0*.');
        user.status = 'pending';
        //return messages;
    } else if (['failed', 'cancelled', 'expired'].includes(user.status)) {
        clearInterval(pollingInterval);
        ctxFn.flowDynamic(`Error: ${user.status}, por favor intentelo de nuevo.`);
        user.status = 'pending';
    }
}
const main = async () => {
    const adapterFlow = createFlow([defaultFlow, welcomeFlow, menuFlow, pendingFlow])

    const adapterProvider = createProvider(Provider)
    const adapterDB = new Database()

    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    adapterProvider.on('message', ({ body, from }) => {
        console.log(`Message Payload:`, { body, from })
        handleCtx(body, from)
    })

    /*
    adapterProvider.server.post(
        '/v1/messages',
        handleCtx(async (bot, req, res) => {
            const { number, message, urlMedia } = req.body
            await bot.sendMessage(number, message, { media: urlMedia ?? null })
            return res.end('sended')
        })
    )

    adapterProvider.server.post(
        '/v1/register',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('REGISTER_FLOW', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/samples',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('SAMPLES', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
            const { number, intent } = req.body
            if (intent === 'remove') bot.blacklist.remove(number)
            if (intent === 'add') bot.blacklist.add(number)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', number, intent }))
        })
    )
        */

    httpServer(+PORT)
}

main()
