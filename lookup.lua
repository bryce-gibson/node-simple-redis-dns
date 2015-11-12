local type = KEYS[1]
local name = KEYS[2]

local lookups = {}
local val = ''
local split = {}

for i in string.gmatch(name, '[^.]*') do
  if i ~= '' then
    split[#split+1] = i
  end
end

for i = #split, 1, -1 do
  local toAdd
  if val == '' then
    toAdd = val
  else
    toAdd = string.sub(val, 2)
  end
  val = split[i] .. toAdd
  if i ~= 1 then val = '*.' .. val end
  lookups[#lookups+1] = type .. ':' .. val
  if(type == 'A') then lookups[#lookups+1] = 'CNAME:' .. val end
end

local doLookup = function(key, cname)
  local cursor = '0'
  local results = {}
  if cname then results[1] = { 'CNAME', name, '', key } end -- [ TYPE, name, address, data ]
  local recordName = string.gsub(key, '%w+:', '') -- remove type prefix
  if string.find(recordName, '*.') == 1 then recordName = name end -- if a wildcard record use the name that was requested
  repeat
    local sscan = redis.call('SSCAN', key, cursor)
    cursor = sscan[1]
    local records = sscan[2]
    for _, record in pairs(records) do results[#results+1] = { type, recordName, record } end -- [ TYPE, name, address, data ]
  until cursor == '0'
  return results
end

for i = #lookups, 1, -1 do
  local v = lookups[i]
  if redis.call('EXISTS', v) == 1 then
    if string.sub(v, 1, 5) == 'CNAME' then return doLookup(redis.call('GET', v), v) end
    return doLookup(v, false)
  end
end
