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
end

for i = #lookups, 1, -1 do
  local v = lookups[i]
  if redis.call('EXISTS', v) == 1 then
    local cursor = '0'
    local results = {}
    repeat
      local sscan = redis.call('SSCAN', v, cursor)
      cursor = sscan[1]
      local records = sscan[2]
      for _, record in pairs(records) do results[#results+1] = record end
    until cursor == '0'
    return results
  end
end
