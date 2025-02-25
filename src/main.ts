//#!/usr/bin/env node

// Native
import path from 'path'
import fs from 'fs'
import { promisify } from 'util'
import { parse } from 'url'

// Packages
import Ajv from 'ajv'
import checkForUpdate from 'update-check'
import chalk from 'chalk'
import arg from 'arg'
// import clipboardy from 'clipboardy'
import schema from '@zeit/schemas/deployment/config-static'

// Utilities
import pkg from '../package.json'
import startEndpoint from './server'

const readFile = promisify(fs.readFile);

const warning = (message) => chalk`{yellow WARNING:} ${message}`;
const info = (message) => chalk`{magenta INFO:} ${message}`;
const error = (message) => chalk`{red ERROR:} ${message}`;

const updateCheck = async (isDebugging) => {
    let update = null;

    try {
        update = await checkForUpdate(pkg);
    } catch (err) {
        const suffix = isDebugging ? ':' : ' (use `--debug` to see full error)';
        console.error(warning(`Checking for updates failed${suffix}`));

        if (isDebugging) {
            console.error(err);
        }
    }

    if (!update) {
        return;
    }

    console.log(`${chalk.bgRed('UPDATE AVAILABLE')} The latest version of \`serve\` is ${update.latest}`);
};

const getHelp = () => chalk`
  {bold.cyan serve} - Static file serving and directory listing

  {bold USAGE}

      {bold $} {cyan serve} --help
      {bold $} {cyan serve} --version
      {bold $} {cyan serve} folder_name
      {bold $} {cyan serve} [-l {underline listen_uri} [-l ...]] [{underline directory}]

      By default, {cyan serve} will listen on {bold 0.0.0.0:3000} and serve the
      current working directory on that address.

      Specifying a single {bold --listen} argument will overwrite the default, not supplement it.

  {bold OPTIONS}

      --help                              Shows this help message

      -v, --version                       Displays the current version of serve

      -l, --listen {underline listen_uri}             Specify a URI endpoint on which to listen (see below) -
                                          more than one may be specified to listen in multiple places

      -p                                  Specify custom port

      -d, --debug                         Show debugging information

      -s, --single                        Rewrite all not-found requests to \`index.html\`

      -c, --config                        Specify custom path to \`serve.json\`

      -C, --cors                          Enable CORS, sets \`Access-Control-Allow-Origin\` to \`*\`

      -n, --no-clipboard                  Do not copy the local address to the clipboard

      -u, --no-compression                Do not compress files

      --no-etag                           Send \`Last-Modified\` header instead of \`ETag\`

      -S, --symlinks                      Resolve symlinks instead of showing 404 errors
	  
	  --ssl-cert                          Optional path to an SSL/TLS certificate to serve with HTTPS
	  
	  --ssl-key                           Optional path to the SSL/TLS certificate\'s private key

	  --ssl-pass                          Optional path to the SSL/TLS certificate\'s passphrase

      --no-port-switching                 Do not open a port other than the one specified when it\'s taken.

  {bold ENDPOINTS}

      Listen endpoints (specified by the {bold --listen} or {bold -l} options above) instruct {cyan serve}
      to listen on one or more interfaces/ports, UNIX domain sockets, or Windows named pipes.

      For TCP ports on hostname "localhost":

          {bold $} {cyan serve} -l {underline 1234}

      For TCP (traditional host/port) endpoints:

          {bold $} {cyan serve} -l tcp://{underline hostname}:{underline 1234}

      For UNIX domain socket endpoints:

          {bold $} {cyan serve} -l unix:{underline /path/to/socket.sock}

      For Windows named pipe endpoints:

          {bold $} {cyan serve} -l pipe:\\\\.\\pipe\\{underline PipeName}
`;

const parseEndpoint = (str) => {
    if (!isNaN(str)) {
        return [str];
    }

    // We cannot use `new URL` here, otherwise it will not
    // parse the host properly and it would drop support for IPv6.
    const url = parse(str);

    switch (url.protocol) {
        case 'pipe:': {
            // some special handling
            const cutStr = str.replace(/^pipe:/, '');

            if (cutStr.slice(0, 4) !== '\\\\.\\') {
                throw new Error(`Invalid Windows named pipe endpoint: ${str}`);
            }

            return [cutStr];
        }
        case 'unix:':
            if (!url.pathname) {
                throw new Error(`Invalid UNIX domain socket endpoint: ${str}`);
            }

            return [url.pathname];
        case 'tcp:':
            url.port = url.port || '3000';
            return [parseInt(url.port, 10), url.hostname];
        default:
            throw new Error(`Unknown --listen endpoint scheme (protocol): ${url.protocol}`);
    }
};


const loadConfig = async (cwd, entry, args) => {
    const files = [
        'serve.json',
        'now.json',
        'package.json'
    ];

    if (args['--config']) {
        files.unshift(args['--config']);
    }

    const config: any = {};

    for (const file of files) {
        const location = path.resolve(entry, file);
        let content = null;

        try {
            content = await readFile(location, 'utf8');
        } catch (err) {
            if ((err as any).code === 'ENOENT') {
                continue;
            }

            console.error(error(`Not able to read ${location}: ${(err as any).message}`));
            process.exit(1);
        }

        try {
            content = JSON.parse(content);
        } catch (err) {
            console.error(error(`Could not parse ${location} as JSON: ${(err as any).message}`));
            process.exit(1);
        }

        if (typeof content !== 'object') {
            console.error(warning(`Didn't find a valid object in ${location}. Skipping...`));
            continue;
        }

        try {
            switch (file) {
                case 'now.json':
                    content = content.static;
                    break;
                case 'package.json':
                    content = content.now.static;
                    break;
            }
        } catch (err) {
            continue;
        }

        Object.assign(config, content);
        console.log(info(`Discovered configuration in \`${file}\``));

        if (file === 'now.json' || file === 'package.json') {
            console.error(warning('The config files `now.json` and `package.json` are deprecated. Please use `serve.json`.'));
        }

        break;
    }

    if (entry) {
        const _public = config['public'];
        config.public = path.relative(cwd, (_public ? path.resolve(entry, _public) : entry));
    }

    if (Object.keys(config).length !== 0) {
        const ajv = new Ajv();
        const validateSchema = ajv.compile(schema);

        if (!validateSchema(config)) {
            const defaultMessage = error('The configuration you provided is wrong:');
            const { message, params } = validateSchema.errors[0];

            console.error(`${defaultMessage}\n${message}\n${JSON.stringify(params)}`);
            process.exit(1);
        }
    }

    // "ETag" headers are enabled by default unless `--no-etag` is provided
    config.etag = !args['--no-etag'];

    return config;
};

(async () => {
    let args = null;

    try {
        args = arg({
            '--help': Boolean,
            '--version': Boolean,
            '--listen': [parseEndpoint],
            '--single': Boolean,
            '--debug': Boolean,
            '--config': String,
            '--no-clipboard': Boolean,
            '--no-compression': Boolean,
            '--no-etag': Boolean,
            '--symlinks': Boolean,
            '--cors': Boolean,
            '--no-port-switching': Boolean,
            '--ssl-cert': String,
            '--ssl-key': String,
            '--ssl-pass': String,
            '-h': '--help',
            '-v': '--version',
            '-l': '--listen',
            '-s': '--single',
            '-d': '--debug',
            '-c': '--config',
            '-n': '--no-clipboard',
            '-u': '--no-compression',
            '-S': '--symlinks',
            '-C': '--cors',
            // This is deprecated and only for backwards-compatibility.
            '-p': '--listen'
        });
    } catch (err) {
        console.error(error((err as any).message));
        process.exit(1);
    }

    if (process.env.NO_UPDATE_CHECK !== '1') {
        await updateCheck(args['--debug']);
    }

    if (args['--version']) {
        console.log(pkg.version);
        return;
    }

    if (args['--help']) {
        console.log(getHelp());
        return;
    }

    if (!args['--listen']) {
        // Default endpoint
        args['--listen'] = [[process.env.PORT || 3000]];
    }

    if (args._.length > 1) {
        console.error(error('Please provide one path argument at maximum'));
        process.exit(1);
    }

    const cwd = process.cwd();
    const entry = args._.length > 0 ? path.resolve(args._[0]) : cwd;

    const config: any = await loadConfig(cwd, entry, args);

    if (args['--single']) {
        const { rewrites } = config;
        const existingRewrites = Array.isArray(rewrites) ? rewrites : [];

        // As the first rewrite rule, make `--single` work
        config.rewrites = [{
            source: '**',
            destination: '/index.html'
        }, ...existingRewrites];
    }

    if (args['--symlinks']) {
        config.symlinks = true;
    }

    for (const endpoint of args['--listen']) {
        startEndpoint(endpoint, config, args);
    }


    process.on('SIGINT', () => {
        console.log(`\n${warning('Force-closing all open sockets...')}`);
        process.exit(0);
    });
    // registerShutdown(() => {
    //     console.log(`\n${info('Gracefully shutting down. Please wait...')}`);

    //     process.on('SIGINT', () => {
    //         console.log(`\n${warning('Force-closing all open sockets...')}`);
    //         process.exit(0);
    //     });
    // });
})();
