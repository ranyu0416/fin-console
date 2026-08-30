#!/usr/bin/env node
/**
 * 命令行重置口令（忘记管理员口令时用）。
 *   node scripts/reset-password.mjs <账号>              # 交互式隐藏输入
 *   printf '%s\n' '新口令' | node scripts/reset-password.mjs <账号>
 *   node scripts/reset-password.mjs <账号> <新口令>     # 仅兼容旧方式，会警告泄露风险
 *   node scripts/reset-password.mjs --list
 * 重置后该账号的所有会话立即失效，下次登录会被要求再改一次。
 */
import readline from 'node:readline';
import { findUserByName, listUsers, passwordProblem, revokeUserSessions, setPassword } from '../lib/auth.js';
import { closeDb } from '../lib/db.js';
import { audit } from '../lib/store.js';

const [arg1, arg2] = process.argv.slice(2);

async function readPipePassword() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.split(/\r?\n/, 1)[0];
}

function askHidden(label) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      rl.close();
      fn(value);
    };

    // readline 默认回显输入；这里仅屏蔽口令字符，关闭后终端设置会由 readline 恢复。
    rl._writeToOutput = (text) => {
      if (text === '\n' || text === '\r\n') process.stdout.write(text);
      else if (text) process.stdout.write('*');
    };
    rl.once('SIGINT', () => {
      process.stdout.write('\n');
      finish(reject, new Error('已取消操作'));
    });
    process.stdout.write(`${label}：`);
    rl.question('', (answer) => finish(resolve, answer));
  });
}

async function readPassword() {
  if (arg2 !== undefined) {
    // 兼容旧自动化入口，但 argv 会暴露给 history 与进程列表，不能把它当作推荐方式。
    console.error('警告：口令作为命令行参数会留在 shell history 和进程列表中；请改用交互输入或 stdin 管道。');
    return arg2;
  }
  if (!process.stdin.isTTY) return readPipePassword();
  const password = await askHidden('请输入新口令');
  const confirm = await askHidden('请再次输入新口令');
  if (password !== confirm) throw new Error('两次输入的口令不一致');
  return password;
}

try {
  if (!arg1 || arg1 === '--list' || arg1 === '-l') {
    const users = listUsers();
    if (!users.length) {
      console.log('尚无账号。启动一次服务即可创建初始管理员。');
    } else {
      console.log('账号列表：');
      for (const u of users) {
        console.log(
          `  ${u.username.padEnd(20)} ${u.role.padEnd(12)} ${u.disabled ? '已停用' : '正常'}  ` +
            `最近登录：${u.last_login || '从未'}`,
        );
      }
    }
    if (!arg1) console.log('\n用法：node scripts/reset-password.mjs <账号> [新口令]');
    process.exit(0);
  }

  const user = findUserByName(arg1);
  if (!user) {
    console.error(`账号「${arg1}」不存在。用 --list 查看现有账号。`);
    process.exit(1);
  }

  const password = await readPassword();
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  setPassword(user.id, password, { mustChange: 1 });
  revokeUserSessions(user.id);
  audit({ actor: 'cli', action: 'user.reset_password', detail: user.username });
  console.log(`已重置「${user.username}」的口令，该账号已下线，下次登录须再次修改口令。`);
} catch (err) {
  console.error(`重置失败：${err.message}`);
  process.exit(1);
} finally {
  closeDb();
}
