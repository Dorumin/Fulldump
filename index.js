const fs = require('fs');
const got = require('got');
const path = require('path');
const yargs = require('yargs');
const readline = require('readline');
const filenamify = require('filenamify');
const stringWidth = require('string-width');

class MessageFormatter {
    constructor(format) {
        this.format = format;
        this.lastId = '0';
        this.log = '';

        this.DISCORD_EPOCH = 1420070400000n;
        this.MS_IN_A_DAY = 86400000;
        this.MONTH_NAMES = [
            'January',
            'February',
            'March',
            'April',
            'May',
            'June',
            'July',
            'August',
            'September',
            'October',
            'November',
            'December'
        ];
    }

    getIdTime(id) {
        const bid = BigInt(id),
        shifted = bid >> 22n,
        time = shifted + this.DISCORD_EPOCH;

        return Number(time);
    }

    pad(n, len = 2) {
        return `${n}`.padStart(len, '0');
    }

    getIdDate(id) {
        return new Date(this.getIdTime(id));
    }

    getAbsDate(id) {
        const time = this.getIdTime(id);

        return Math.floor(time / this.MS_IN_A_DAY);
    }

    getDate(d) {
        return `${this.pad(d.getUTCDate())}/${this.pad(d.getUTCMonth() + 1)}/${this.pad(d.getUTCFullYear())}`;
    }

    getNamedDate(d) {
        return `${d.getUTCDate()} ${this.MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }

    getTime(d) {
        return `${this.pad(d.getUTCHours())}:${this.pad(d.getUTCMinutes())}:${this.pad(d.getUTCSeconds())}`;
    }

    writeTextMessage(message) {
        const lastDate = this.getAbsDate(this.lastId);
        const curDate = this.getAbsDate(message.id);

        if (lastDate !== curDate) {
            this.log += this.getMessageSeparator(message);
        }

        this.log += this.formatTextMessage(message);
        this.lastId = message.id;
    }

    getMessageSeparator(message) {
        const date = this.getIdDate(message.id);

        return `\n---- ${this.getNamedDate(date)} ----\n`;
    }

    formatTextMessage(message) {
        const date = this.getIdDate(message.id);
        let log = `[${this.getTime(date)}]`;

        if (message.author && message.author.username) {
            log += ` ${message.author.username}`;
        }

        const content = this.getMessageText(message);

        if (content) {
            if (message.author && message.author.username) {
                log += `: ${content}`;
            } else {
                log += ` ${content}`;
            }
        }

        if (message.attachments.length) {
            for (const attachment of message.attachments) {
                log += `\n${attachment.url}`
            }

            // Extra line to separate messages with attachments from those without
            log += '\n';
        }

        log += '\n';

        return log;
    }

    formatUsers(users) {
        return users.map(user => `${user.username}#${user.discriminator}`).join(', ');
    }

    getMessageText(message) {
        switch (message.type) {
            // DEFAULT
            case 0:
                return message.content;
            // RECIPIENT_ADD
            case 1:
                const wasInvited = message.author.id !== message.mentions[0].id;

                if (wasInvited) {
                    return `${message.author.username} added ${this.formatUsers(message.mentions)} to the group chat`;
                }

                return `${message.author.username} joined the group chat`;
            // RECIPIENT_REMOVE
            case 2:
                const wasRemoved = message.author.id !== message.mentions[0].id;

                if (wasRemoved) {
                    return `${message.author.username} removed ${this.formatUsers(message.mentions)} from the group chat`;
                }

                return `${message.author.username} left the group chat`;
            // call
            case 3:
                return `${message.author.username} called.`;
            // CHANNEL_NAME_CHANGE
            case 4:
                return `${message.author.username} set the group chat title to ${message.content}`;
            // CHANNEL_ICON_CHANGE
            case 5:
                return `${message.author.username} changed the group chat icon`;
            // CHANNEL_PINNED_MESSAGE
            case 6:
                let base = `${message.author.username} pinned a message to this channel`;

                if (message.message_reference) {
                    base += ` (${message.message_reference.message_id})`;
                }

                return base;
            // GUILD_MEMBER_JOIN
            case 7:
                return `${message.author.username} has joined the server`;
            // USER_PREMIUM_GUILD_SUBSCRIPTION
            case 8:
            // USER_PREMIUM_GUILD_SUBSCRIPTION_TIER1
            case 9:
            // USER_PREMIUM_GUILD_SUBSCRIPTION_TIER2
            case 10:
            // USER_PREMIUM_GUILD_SUBSCRIPTION_TIER3
            case 11:
                return `${message.author.username} has boosted the server`;
            // CHANNEL_FOLLOW_ADD
            case 12:
                return `${message.author.username} has followed a server`;
            default:
                return `INVALID_TYPE_${message.type}`;
        }
    }

    write(message) {
        switch (this.format) {
            case 'json':
                return this.writeJSONMessage(message);
            case 'text':
                return this.writeTextMessage(message);
            case 'log':
                return this.writeLogMessage(message);
        }
    }

    clear() {
        this.log = '';
    }

    export() {
        return this.log;
    }

    flush() {
        const log = this.export();
        this.clear();

        return log;
    }
}

class Dumper {
    constructor() {
        // Global state
        this.state = {
            dir: '',
            name: '',
            token: '',
            format: '',
            logText: '',
            streams: {},
            channels: [],
            fetching: [],
            // finished: 0, // Won't need to use if I don't remove finished channels
            concurrent: 0,
            drawnFrames: 0,
            drawTimeout: 0,
            flushTimeout: 0,
        };

        // Drawing
        this.stdin = process.stdin;
        this.stdout = process.stdout;
        this.rl = readline.createInterface({
            input: this.stdin,
            output: this.stdout
        });

        // Command line arg parsing
        this.args = yargs
            .wrap(yargs.terminalWidth())
            .scriptName('fulldump')
            .option('token', {
                alias: 't',
                type: 'string',
                desc: 'User token',
                demand: 'We need an user token to authenticate our requests!'
            })
            .option('concurrent', {
                alias: 'c',
                type: 'number',
                desc: 'Channels to fetch at a time',
                default: 12
            })
            .option('format', {
                alias: 'f',
                type: 'string',
                desc: 'Format to use, must be `json`, `text`, or `log`',
                default: 'text',
                choices: ['json', 'text', 'log']
            })
            .option('name', {
                alias: 'n',
                type: 'string',
                desc: 'Name to label dump with; if absent, account username'
            })
            .option('dir', {
                type: 'string',
                desc: 'The directory to dump the log folder to'
            })
            // .option('exclude', {
            //     alias: 'x',
            //     type: 'string',
            //     desc: 'Message IDs to exclude from the pindump and empty procedures',
            //     default: '',
            //     coerce: ids => ids.split(',')
            // })
            .argv;
    }

    async prepState() {
        if (this.args.dir) {
            if (path.isAbsolute(this.args.dir)) {
                this.state.dir = this.args.dir;
            } else {
                this.state.dir = path.join(__dirname, this.args.dir);
            }
        } else {
            this.state.dir = path.join(__dirname, 'dumps');
        }

        this.state.token = this.args.token;
        this.state.format = this.args.format;
        this.state.concurrent = this.args.concurrent;

        const [
            me,
            settings,
            dms,
            guilds
        ] = await Promise.all([
            this.api(`users/@me`),
            this.api(`users/@me/settings`).catch(() => null),
            this.api(`users/@me/channels`),
            this.api(`users/@me/guilds`)
        ]);

        this.state.name = this.args.name || me.username;

        if (settings) {
            const positions = settings.guild_positions;
            guilds.sort((a, b) => positions.indexOf(a.id) - positions.indexOf(b.id));
        }

        this.state.channels = await this.queryGuildChannels(guilds);
        this.state.channels.push(...dms);

        this.rl.close();
    }

    async dump() {
        await this.prepState();

        await this.fetchAllChannels(this.state);

        this.stdout.write('\x1B[?25h');
    }

    chunk() {
        let final = [''],
        current = 0;

        for (let i = 0; i < array.length; i++) {
            const item = array[i];
            if (item.length > maxlen) continue;
            if ((final[current] + item).length > maxlen) {
                current++;
                final[current] = item;
            } else {
                final[current] += item;
            }
        }

        return final;
    }

    log(message) {
        this.state.logText += message + '\n';
    }

    wait(ms) {
        return new Promise(res => setTimeout(res, ms));
    }

    api(path, method = 'GET', searchParams) {
        return got(`https://discordapp.com/api/v6/${path}`, {
            method,
            searchParams,
            headers: {
                authorization: this.state.token
            }
        }).json();
    }

    async queryGuildChannels(guilds) {
        const channels = [];

        for (let i = 0; i < guilds.length; i++) {
            const guild = guilds[i];

            let q = `Log all channels in ${guild.name}? [y/n]`;
            let perm = '';
            const owner = guild.owner;
            const admin = guild.permissions & 8;

            if (admin) perm = 'admin';
            if (owner) perm = 'owner';

            if (perm) q += ` (${perm})`;

            const res = await this.ask(q);

            if (res.startsWith('y')) {
                const chans = await this.fetchGuildChannels(guild);

                console.log(`Adding ${chans.length} channels`);
                channels.push(...chans);
            } else if (res.startsWith('n')) {
                // ya know, skip
            } else {
                break;
            }
        }

        return channels;
    }

    async fetchGuildChannels(guild) {
        const channels = await this.api(`guilds/${guild.id}/channels`);
        const textChannels = channels.filter(chan => chan.type === 0);

        textChannels.forEach(chan => chan.guild = guild);

        return textChannels;
    }

    ask(question) {
        return new Promise(res => this.rl.question(question + '\n', res));
    }

    fetchAllChannels() {
        return Promise.all(
            this.parallelLimit(
                this.state.channels.map(channel => () => this.saveChannel(channel)),
                this.state.concurrent
            )
        );
    }

    parallelLimit(functions, count) {
        const executing = new Set();

        return functions.map(async func => {
            while (executing.size >= count) {
                await Promise.race(executing);
            }

            const promise = func();

            executing.add(promise);

            await promise;

            executing.delete(promise);
        });
    }

    getChannelPath(channel) {
        const name = this.getChannelName(channel);
        const filename = filenamify(name) + '.txt';
        const userFolder = filenamify(this.state.name);
        const chanFolder = channel.guild
            ? filenamify(channel.guild.name)
            : 'DMs';
        const filePath = path.join(this.state.dir, userFolder, chanFolder, filename);

        return filePath;
    }

    async getFileStream(channel) {
        const filePath = this.getChannelPath(channel);
        const fileFolder = path.dirname(filePath);

        await this.mkdirRecursive(fileFolder);

        return fs.createWriteStream(filePath);
    }

    mkdirRecursive(dirPath) {
        return new Promise((resolve, reject) => {
            fs.mkdir(dirPath, { recursive: true }, (err) => {
                if (err) {
                    reject(err);
                    return;
                }

                resolve();
            });
        });
    }

    deleteFile(path) {
        return new Promise((resolve, reject) => {
            fs.unlink(path, (err) => {
                if (err) {
                    reject(err);
                    return;
                }

                resolve();
            });
        });
    }

    async saveChannel(channel) {
        channel.fetchedAmount = 0;

        // We've got list full of channels! One must be finished, so we'll replace it
        if (this.state.fetching.length >= this.state.concurrent) {
            let i = this.state.fetching.length;

            while (i--) {
                const executingChannel = this.state.fetching[i];

                if (executingChannel.finished) {
                    // Found our slot
                    this.state.fetching[i] = channel;
                    break;
                }
            }
        } else {
            // Let's just push at the end
            this.state.fetching.push(channel);
        }

        await this.flushChannel(channel);

        // this.finished++; We'd need it if we cleared at the end, but we don't! We'll leave the finished channels statuses in
    }

    async* fetchAllChannelMessages(channel) {
        let lastId = '0',
        path = `channels/${channel.id}/messages`;

        channel.fetchedAmount = 0;

        while (true) {
            try {
                const messages = await this.api(path, 'GET', {
                    limit: 100,
                    after: lastId
                });

                if (!messages.length) break;

                lastId = messages[0].id;
                channel.fetchedAmount += messages.length;

                let i = messages.length;
                while (i--) {
                    yield messages[i];
                }
            } catch(e) {
                if (e.name === 'HTTPError') {
                    // Forbidden
                    if (e.toString().includes('403')) {
                        break;
                    }
                }

                await this.wait(1000);
            }
        }
    }

    getChannelName(channel) {
        return channel.name || channel.recipients.map(a => a.username).join(', ');
    }

    // Deals with streaming channel contents to disk in a given format
    async flushChannel(channel) {
        const stream = await this.getFileStream(channel);
        const formatter = new MessageFormatter(this.state.format);

        for await (const message of this.fetchAllChannelMessages(channel)) {

            formatter.write(message);
            this.schedule('flushTimeout', () => stream.write(formatter.flush()));
            this.scheduleDraw();
        }

        stream.end();
        // Mark channel as finished to be overwritten by the renderer
        channel.finished = true;
        this.scheduleDraw();

        if (channel.fetchedAmount === 0) {
            await this.deleteFile(this.getChannelPath(channel));
        }
    }

    schedule(id, cb, ms = 16) {
        clearTimeout(this.state[id]);
        this.state[id] = setTimeout(cb.bind(this), 16);
    }

    scheduleDraw() {
        this.schedule('drawTimeout', this.draw);
        // clearTimeout(this.state.drawTimeout);
        // this.state.drawTimeout = setTimeout(() => {
        //     this.draw();
        // }, 16);
    }

    // Character width-sensitive padEnd function
    padEnd(str, min, char = ' ') {
        const width = stringWidth(str);
        const pad = new Array(Math.max(0, 1 + min - width)).join(char);

        return str + pad;
    }

    draw() {
        let text = `\x1B[?25lWe're generating a full dump for ${this.state.name}, please wait\n`;
        let widestName = 52;

        for (const channel of this.state.fetching) {
            const name = this.getChannelName(channel);
            const width = stringWidth(name);

            if (width > widestName) {
                widestName = width;
            }
        }

        for (const channel of this.state.fetching) {
            const type = channel.guild ? 'CH' : 'DM';
            const name = this.getChannelName(channel);
            let paddedName = this.padEnd(name, widestName);
            const status = channel.finished
                ? 'DONE'
                : `${channel.fetchedAmount}`.padStart(3, '0');

            text += `[${type}] ${paddedName} [${status}]\n`;
        }

        text += this.state.logText;

        this.stdout.cursorTo(0, 0);
        this.stdout.clearScreenDown();
        this.stdout.write(text);
    }
}

new Dumper().dump();