sub init()
    m.video = m.top.findNode("video")
    m.video.setFocus(true)
end sub

sub loadContent()
    if m.top.contentUrl = "" then return
    content = CreateObject("roSGNode", "ContentNode")
    content.url = m.top.contentUrl
    content.streamFormat = "hls"
    content.title = "Remote Workspace"
    m.video.content = content
    m.video.control = "play"
end sub

sub handleInput()
    command = m.top.inputCommand
    if command = invalid or command.command = invalid then return
    if command.command = "play" then
        m.video.control = "resume"
    else if command.command = "pause" then
        m.video.control = "pause"
    else if command.command = "stop" then
        m.video.control = "stop"
    else if command.command = "seek" and command.position <> invalid then
        m.video.seek = command.position.toFloat()
    end if
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if press and key = "back" then
        m.video.control = "stop"
        return false
    end if
    return false
end function

