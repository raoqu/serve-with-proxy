import http from 'http';
import https from 'https'
import fs from 'fs'
import os from 'os'
import { promisify } from 'util'
import chalk from 'chalk'

import boxen from 'boxen'
import compression from 'compression'
import handler from 'serve-handler'
import handleProxy from './proxy'

const interfaces = os.networkInterfaces();

const info = (message) => chalk`{magenta INFO:} ${message}`;
const error = (message) => chalk`{red ERROR:} ${message}`;

const getNetworkAddress = () => {
    for (const name of Object.keys(interfaces)) {
        for (const _interface of interfaces[name]) {
            const { address, family, internal } = _interface;
            if (family === 'IPv4' && !internal) {
                return address;
            }
        }
    }
    return null
};


const compressionHandler = promisify(compression());

const startEndpoint = (endpoint, config, args, previous = false) => {
    const { isTTY } = process.stdout;
    const clipboard = args['--no-clipboard'] !== true;
    const compress = args['--no-compression'] !== true;
    const httpMode = args['--ssl-cert'] && args['--ssl-key'] ? 'https' : 'http';

    const serverHandler = async (request, response) => {
        if (args['--cors']) {
            response.setHeader('Access-Control-Allow-Origin', '*');
        }
        if (compress) {
            await compressionHandler(request, response);
        }

        if( ! handleProxy(request, response, config) ){
            return handler(request, response, config);
        }
    };

    const sslPass = args['--ssl-pass'];

    const server = httpMode === 'https'
        ? https.createServer({
            key: fs.readFileSync(args['--ssl-key']),
            cert: fs.readFileSync(args['--ssl-cert']),
            passphrase: sslPass ? fs.readFileSync(sslPass).toString() : ''
        }, serverHandler)
        : http.createServer(serverHandler);

    server.on('error', (err) => {
        if ((err as any).code === 'EADDRINUSE' && endpoint.length === 1 && !isNaN(endpoint[0]) && args['--no-port-switching'] !== true) {
            startEndpoint([0], config, args, endpoint[0]);
            return;
        }

        console.error(error(`Failed to serve: ${err.stack}`));
        process.exit(1);
    });

    server.listen(...endpoint, async () => {
        const details = server.address();
        registerShutdown(() => server.close());

        let localAddress = null;
        let networkAddress = null;

        if (typeof details === 'string') {
            localAddress = details;
        } else if (typeof details === 'object' && details.port) {
            const address = details.address === '::' ? 'localhost' : details.address;
            const ip = getNetworkAddress();

            localAddress = `${httpMode}://${address}:${details.port}`;
            networkAddress = ip ? `${httpMode}://${ip}:${details.port}` : null;
        }

        if (isTTY && process.env.NODE_ENV !== 'production') {
            let message = chalk.green('Serving!');

            if (localAddress) {
                const prefix = networkAddress ? '- ' : '';
                const space = networkAddress ? '            ' : '  ';

                message += `\n\n${chalk.bold(`${prefix}Local:`)}${space}${localAddress}`;
            }

            if (networkAddress) {
                message += `\n${chalk.bold('- On Your Network:')}  ${networkAddress}`;
            }

            if (previous) {
                message += chalk.red(`\n\nThis port was picked because ${chalk.underline(previous)} is in use.`);
            }

            // if (clipboard) {
            //     try {
            //         await clipboardy.write(localAddress);
            //         message += `\n\n${chalk.grey('Copied local address to clipboard!')}`;
            //     } catch (err) {
            //         console.error(error(`Cannot copy to clipboard: ${(err as any).message}`));
            //     }
            // }

            console.log(boxen(message, {
                padding: 1,
                borderColor: 'green',
                margin: 1
            }));
        } else {
            const suffix = localAddress ? ` at ${localAddress}` : '';
            console.log(info(`Accepting connections${suffix}`));
        }
    });
};

const registerShutdown = (fn) => {
    let run = false;

    const wrapper = () => {
        if (!run) {
            run = true;
            fn();
        }
    };

    process.on('SIGINT', wrapper);
    process.on('SIGTERM', wrapper);
    process.on('exit', wrapper);
};

export default startEndpoint;