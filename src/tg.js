const Table = require('cli-table3')
const dayjs = require('dayjs')
const axios = require('@viegg/axios')
const HttpsProxyAgent = require('https-proxy-agent')

const { db } = require('../db')
const { gen_count_body, validate_fid, real_copy } = require('./gd')
const { AUTH, DEFAULT_TARGET } = require('../config')
const { tg_token } = AUTH

if (!tg_token) throw new Error('请先在auth.js里设置tg_token')
const { https_proxy } = process.env
const axins = axios.create(https_proxy ? { httpsAgent: new HttpsProxyAgent(https_proxy) } : {})

module.exports = { send_count, send_help, sm, extract_fid, reply_cb_query, send_choice, send_task_info, send_all_tasks, tg_copy }

function send_help (chat_id) {
  const text = `<pre>[使用帮助]
命令 ｜ 说明

/help | 返回本条使用说明

/count shareID | 返回sourceID的文件统计信息, sourceID可以是google drive分享网址本身，也可以是分享ID

/copy sourceID targetID | 将sourceID的文件复制到targetID里（会新建一个文件夹），若不填targetID，则会复制到默认位置（在config.js里设置）。返回拷贝任务的taskID

/task taskID | 返回对应任务的进度信息，若不填则返回所有正在运行的任务进度，若填 all 则返回所有任务列表
</pre>`
  return sm({ chat_id, text, parse_mode: 'HTML' })
}

function send_choice ({ fid, chat_id }) {
  return sm({
    chat_id,
    text: `识别出分享ID ${fid}，请选择动作`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '文件统计', callback_data: `count ${fid}` },
          { text: '开始复制', callback_data: `copy ${fid}` }
        ]
      ]
    }
  })
}

async function send_all_tasks (chat_id) {
  let records = db.prepare('select id, status, ctime from task').all()
  if (!records.length) return sm({ chat_id, text: '数据库中没有任务记录' })
  const tb = new Table({ style: { head: [], border: [] } })
  const headers = ['ID', 'status', 'ctime']
  records = records.map(v => {
    const { id, status, ctime } = v
    return [id, status, dayjs(ctime).format('YYYY-MM-DD HH:mm:ss')]
  })
  tb.push(headers, ...records)
  const text = tb.toString().replace(/─/g, '—')
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`
  return axins.post(url, {
    chat_id,
    parse_mode: 'HTML',
    text: `所有拷贝任务：\n<pre>${text}</pre>`
  }).catch(async err => {
    const description = err.response && err.response.data && err.response.data.description
    if (description && description.includes('message is too long')) {
      const text = [headers].concat(records).map(v => v.join('\t')).join('\n')
      return sm({ chat_id, parse_mode: 'HTML', text: `所有拷贝任务：\n<pre>${text}</pre>` })
    }
    console.error(err)
  })
}

async function send_task_info ({ task_id, chat_id }) {
  const record = db.prepare('select * from task where id=?').get(task_id)
  if (!record) return sm({ chat_id, text: '数据库不存在此任务ID：' + task_id })

  const gen_link = fid => `<a href="https://drive.google.com/drive/folders/${fid}">${fid}</a>`
  const { source, target, status, copied, mapping, ctime, ftime } = record
  const { summary } = db.prepare('select summary from gd where fid=?').get(source) || {}
  const { file_count, folder_count, total_size } = summary ? JSON.parse(summary) : {}
  const copied_files = copied ? copied.trim().split('\n').length : 0
  const copied_folders = mapping ? (mapping.trim().split('\n').length - 1) : 0
  let text = '任务编号：' + task_id + '\n'
  text += '源ID：' + gen_link(source) + '\n'
  text += '目的ID：' + gen_link(target) + '\n'
  text += '任务状态：' + status + '\n'
  text += '创建时间：' + dayjs(ctime).format('YYYY-MM-DD HH:mm:ss') + '\n'
  text += '完成时间：' + (ftime ? dayjs(ftime).format('YYYY-MM-DD HH:mm:ss') : '未完成') + '\n'
  text += '目录进度：' + copied_folders + '/' + (folder_count === undefined ? '未知数量' : folder_count) + '\n'
  text += '文件进度：' + copied_files + '/' + (file_count === undefined ? '未知数量' : file_count) + '\n'
  text += '总大小：' + (total_size || '未知大小')
  return sm({ chat_id, text, parse_mode: 'HTML' })
}

async function tg_copy ({ fid, target, chat_id }) { // return task_id
  target = target || DEFAULT_TARGET
  if (!target) {
    sm({ chat_id, text: '请输入目的地ID或先在config.js里设置默认复制目的地ID(DEFAULT_TARGET)' })
    return
  }

  let record = db.prepare('select id, status from task where source=? and target=?').get(fid, target)
  if (record) {
    if (record.status === 'copying') {
      sm({ chat_id, text: '已有相同源ID和目的ID的任务正在进行，查询进度可输入 /task ' + record.id })
      return
    } else if (record.status === 'finished') {
      sm({ chat_id, text: '有相同源ID和目的ID的任务已复制完成，如需重新复制请更换目的地' })
      return
    }
  }

  real_copy({ source: fid, target, not_teamdrive: true, service_account: true, is_server: true })
    .then(folder => {
      if (!record) record = {} // 防止无限循环
      if (!folder) return
      const link = 'https://drive.google.com/drive/folders/' + folder.id
      sm({ chat_id, text: `${fid} 复制完成，新文件夹链接：${link}` })
    })
    .catch(err => {
      if (!record) record = {}
      console.error('复制失败', fid, '-->', target)
      console.error(err)
      sm({ chat_id, text: '复制失败，失败消息：' + err.message })
    })

  while (!record) {
    record = db.prepare('select id from task where source=? and target=?').get(fid, target)
    await sleep(1000)
  }
  return record.id
}

function sleep (ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms)
  })
}

function reply_cb_query ({ id, data }) {
  const url = `https://api.telegram.org/bot${tg_token}/answerCallbackQuery`
  return axins.post(url, {
    callback_query_id: id,
    text: '开始执行 ' + data
  })
}

async function send_count ({ fid, chat_id }) {
  const table = await gen_count_body({ fid, type: 'tg', service_account: true })
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`
  const gd_link = `https://drive.google.com/drive/folders/${fid}`
  return axins.post(url, {
    chat_id,
    parse_mode: 'HTML',
    // todo 输出文件名
    text: `<pre>${gd_link}
${table}</pre>`
  }).catch(async err => {
    const description = err.response && err.response.data && err.response.data.description
    if (description && description.includes('message is too long')) {
      const smy = await gen_count_body({ fid, type: 'json', service_account: true })
      const { file_count, folder_count, total_size } = JSON.parse(smy)
      return sm({
        chat_id,
        parse_mode: 'HTML',
        text: `文件统计：<a href="https://drive.google.com/drive/folders/${fid}">${fid}</a>\n<pre>
表格太长超出telegram消息限制，只显示概要：
文件总数：${file_count}
目录总数：${folder_count}
合计大小：${total_size}
</pre>`
      })
    }
    throw err
  })
}

function sm (data) {
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`
  return axins.post(url, data).catch(err => {
    console.error('fail to post', url, data)
    console.error(err)
  })
}

function extract_fid (text) {
  text = text.replace(/^\/count/, '').replace(/^\/copy/, '').trim()
  const [source, target] = text.split(' ').map(v => v.trim())
  if (validate_fid(source)) return source
  try {
    if (!text.startsWith('http')) text = 'https://' + text
    const u = new URL(text)
    if (u.pathname.includes('/folders/')) {
      const reg = /\/folders\/([a-zA-Z0-9_-]{10,100})/
      const match = u.pathname.match(reg)
      return match && match[1]
    }
    return u.searchParams.get('id')
  } catch (e) {
    return ''
  }
}
