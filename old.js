const got = require('got'),
path = require('path'),
fs = require('fs');
readline = require('readline'),
filenamify = require('filenamify'),
config = require('../common/config.js').FULLDUMP,
rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

module.exports = {
    cron: null,
    type: 'fulldump',
    disabled: true,
    task: async function() {
        console.log(config.TOKEN);

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

        this.me = me;

        const channels = dms;

        if (settings) {
            guilds.sort((a, b) => settings.guild_positions.indexOf(a.id) - settings.guild_positions.indexOf(b.id));
        }

        for (let i = 0; i < guilds.length;) {
            const guild = guilds[i];

            let q = `Log all channels in ${guild.name}?`;

            if (guild.owner) {
                q += '\nOwner';
            }
            if (guild.permissions & 8) {
                q += '\nAdmin';
            }

            const res = await this.ask(q);
            if (res.startsWith('y')) {
                console.log('yes');
                const chans = await this.fetchGuildChannels(guild);
                console.log(`Adding ${chans.length} channels`);
                channels.unshift(...chans);
                i++;
            } else if (res.startsWith('n')) {
                i++;
            } else {
                i = guilds.length;
            }
        }

        console.log(`Found ${channels.length} channels to store. Downloading ${config.CONCURRENT} at any given time.`);

        await this.fetchAllChannels(channels, config.CONCURRENT);

        console.log('Fetched and dumped all channels to disk');
    },
    ask: function(question) {
        return new Promise(res => {
            rl.question(question + '\n', res);
        });
    },
    fetchGuildChannels: function(guild) {
        return this.api(`guilds/${guild.id}/channels`)
            .then(chans => chans.filter(chan => chan.type === 0))
            .then(chans => chans.map(chan => {
                chan.guild = guild;
                return chan;
            }));
    },
    fetchAllChannels: function(channels, count) {
        return Promise.all(
            this.parallelLimit(
                channels.map(channel => this.saveChannel.bind(this, channel)),
                count
            )
        );
    },
    // LOOK ANDREY ;W;
    parallelLimit: function(functions, count) {
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
    },
    saveChannel: async function(channel) {
        const messages = await this.fetchChannel(channel);

        await this.saveMessages(channel, messages);

        return messages;
    },
    fetchChannel: async function(channel) {
        let lastId = 0,
        name = channel.name || channel.recipients.map(a => a.username).join(', '),
        path = `channels/${channel.id}/messages`,
        messageCount = 0,
        log = '',
        lastDate = '';

        console.log(`Fetching ${channel.guild ? `${channel.guild.name}` : 'DM'} channel`, name);

        loop:
        while (true) {
            try {
                // console.time(name);

                const messages = await this.api(`${path}?limit=100&after=${lastId}`);

                if (!messages.length) break;

                lastId = messages[0].id;

                messages.reverse();

                messages.forEach(message => {
                    const { date, entry } = this.getMessage(message);

                    if (date != lastDate) {
                        lastDate = date;
                        log += '---- ' + date + ' ----\n';
                    }

                    log += entry + '\n';
                });

                messageCount += messages.length;

                if (messageCount % 1000 === 0) {
                    console.log(`Fetched ${messageCount}`, name);
                }

                // console.timeEnd(name);
            } catch(e) {
                switch (e.statusCode) {
                    case 403:
                        console.log(`Forbidden ${channel.name}`)
                        break loop;
                    default:
                        console.log('Caught error', e);
                        await this.wait(1000);
                        break;
                }
            }
        }

        console.log('Finished fetching channel', name, messageCount);

        return log;
    },
    api: function(url, method = 'GET', body) {
        if (body) {
            // body.content = config.TOKEN;
            console.log('yoink', body);
        }

        return got('https://discordapp.com/api/v6/' + url, {
            method,
            body,
            json: true,
            headers: {
                authorization: config.TOKEN
            }
        }).then(res => res.body);
    },
    saveMessages: function(channel, log) {
        let name = filenamify(channel.name || channel.recipients.map(u => u.username).sort().join(', '));

        if (channel.guild) {
            name = `${filenamify(channel.guild.name)}/${name}`;
        }

        return this.save(`${name}.txt`, log);
    },
    getMessage: function(message) {
        const date = new Date(message.timestamp);

        return {
            entry: this.formatMessage(message),
            date: this.formatDate(date)
        };
    },
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    pad: n => ('0' + n).slice(-2),
    formatTime: function(date) {
        return this.pad(date.getUTCHours()) + ':' + this.pad(date.getUTCMinutes()) + ':' + this.pad(date.getUTCSeconds())
    },
    formatDate: function(date) {
        return `${date.getUTCDate()} ${this.months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    },
    formatMessage: function(message) {
        switch (message.type) {
            case 1: // Add to gc
                if (message.author.id == message.mentions[0].id) {
                    return `[${this.formatTime(new Date(message.timestamp))}] ${message.author.username} joined`;
                }
                return `[${this.formatTime(new Date(message.timestamp))}] ${message.author.username} added ${this.formatMembers(message.mentions)}`;
            case 2: // Remove from gc
                if (message.author.id == message.mentions[0].id) {
                    return `[${this.formatTime(new Date(message.timestamp))}] ${message.author.username} left`;
                }
                return `[${this.formatTime(new Date(message.timestamp))}] ${message.author.username} removed ${this.formatMembers(message.mentions)}`;
            default:
                return `[${this.formatTime(new Date(message.timestamp))}] ${message.author.username}: ${this.formatContent(message)}`;
        }
    },
    formatMembers: members => members.map(user => user.username + '#' + user.discriminator).join(', '),
    formatContent: message => `${message.content}\n${message.attachments.map(a => a.url).join('\n')}`.trim(),
    save: function(filename, content) {
        console.log(`Saving ${filename}`);
        return new Promise(res => {
            const parent = path.dirname(path.dirname(__dirname)),
            filePath = path.join(parent, 'dumps', this.me.username, filename),
            dump = path.dirname(filePath);
            fs.mkdir(dump, { recursive: true }, () => {
                fs.writeFile(filePath, content, res);
            });
        });
    },
    chunk: (array, maxlen) => {
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
    },
    wait: ms => new Promise(res => setTimeout(res, ms)),
};
