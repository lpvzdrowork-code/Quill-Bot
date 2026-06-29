import { Events } from 'discord.js';
import type { GuildMember, PartialGuildMember } from 'discord.js';
import { Embeds } from '../utils/embeds.js';
import { sendLog } from '../utils/channelLogger.js';
import { createLogger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

const log = createLogger('GuildMemberRemove');

const event: BotEvent = {
    name: Events.GuildMemberRemove,
    once: false,
    async execute(...args) {
        const member = args[0] as GuildMember | PartialGuildMember;

        const user = member.user;
        if (!user) {
            log.warn('Received GuildMemberRemove with no user. Skipping.');
            return;
        }

        log.info(`${user.username} left ${member.guild.name}.`);

        await sendLog('memberLog', Embeds.memberLeave(user));
    },
};

export default event;
